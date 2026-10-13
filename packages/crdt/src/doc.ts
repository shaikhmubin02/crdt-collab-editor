import { LamportClock } from './clock.ts';
import { compareIds, isReplicaId, isRoot, ROOT, type Id, type ReplicaId } from './id.ts';
import { InvalidOpError, type DeleteOp, type InsertOp, type Op } from './ops.ts';
import { PendingBuffer, type Dependency } from './pending.ts';
import { vvGet, type VersionVector } from './version-vector.ts';

/**
 * A run: a maximal chain of characters typed one after another by one replica. Character k has
 * ID (clock + k, replica), seq (seq + k), and origin character k - 1 (character 0 has `origin`).
 * All characters in a run share one tombstone flag. Typing "hello" costs one Run, not five items.
 */
interface Run {
  readonly replica: ReplicaId;
  readonly clock: number;
  readonly seq: number;
  readonly origin: Id;
  text: string;
  deleted: boolean;
  block: Block;
}

/**
 * Runs are kept in document order in a doubly linked list of blocks, each holding at most
 * MAX_BLOCK_RUNS runs and caching its visible character count, so a visible index is found by
 * skipping whole blocks. Every block except an empty head (empty document) holds at least one run.
 */
interface Block {
  runs: Run[];
  visible: number;
  prev: Block | null;
  next: Block | null;
}

/**
 * Consecutive deletes by one replica (contiguous clock and seq) whose targets step through
 * consecutive clocks of one replica: forward delete (+1), backspace (-1), or a single delete (0).
 */
interface DeleteRun {
  readonly clock: number;
  readonly seq: number;
  len: number;
  readonly target: Id;
  step: number;
}

const MAX_BLOCK_RUNS = 128;

/**
 * Serialized document state. Runs are listed in document order; replica IDs are interned in
 * `replicas` and referenced by index (-1 for ROOT). Contains every integrated op, so a document
 * restored from a snapshot can still serve `opsSince` for its entire history.
 */
export interface DocSnapshot {
  readonly version: 1;
  /** Highest Lamport clock observed. */
  readonly clock: number;
  readonly replicas: readonly ReplicaId[];
  /** [replica, clock, seq, originReplica, originClock, text, deleted] */
  readonly runs: readonly (readonly [number, number, number, number, number, string, 0 | 1])[];
  /** [replica, clock, seq, len, targetReplica, targetClock, step] */
  readonly deletes: readonly (readonly [number, number, number, number, number, number, number])[];
}

export interface DocStats {
  /** Visible characters. */
  readonly length: number;
  /** Characters including tombstones. */
  readonly chars: number;
  readonly runs: number;
  readonly blocks: number;
  readonly deleteRuns: number;
  readonly pending: number;
}

/**
 * A replicated text document: an RGA (Replicated Growable Array) sequence CRDT.
 *
 * Every character ever inserted is an element with a unique ID; deletes only mark elements as
 * tombstones, so positions referenced by concurrent ops stay valid. Replicas that have integrated
 * the same set of ops have identical element sequences, whatever order the ops arrived in.
 *
 * Local edits (`insert`, `delete`) are applied immediately and return the ops to broadcast.
 * Remote ops go through `apply`, which is idempotent and accepts any delivery order: ops whose
 * dependencies haven't arrived are buffered until they do.
 *
 * Representation: run-length-encoded runs in a block list (see Run, Block), plus a per-replica
 * index of runs sorted by clock for O(log n) ID lookup. The runs and delete records double as the
 * op log: `opsSince` reconstructs ops from them rather than storing every op object.
 */
export class Doc {
  readonly replica: ReplicaId;
  readonly #clock: LamportClock;
  #seq = 0;
  readonly #head: Block = { runs: [], visible: 0, prev: null, next: null };
  /** Each replica's runs, sorted by clock (their clock ranges are disjoint). */
  readonly #runsByReplica = new Map<ReplicaId, Run[]>();
  /** Each replica's delete records, in seq order. */
  readonly #deletesByReplica = new Map<ReplicaId, DeleteRun[]>();
  /** Highest contiguous seq integrated per replica. */
  readonly #vv = new Map<ReplicaId, number>();
  readonly #pending = new PendingBuffer();
  #length = 0;
  #chars = 0;

  constructor(replica: ReplicaId, clock = 0) {
    if (!isReplicaId(replica)) {
      throw new RangeError(`invalid replica ID: ${JSON.stringify(replica)}`);
    }
    this.replica = replica;
    this.#clock = new LamportClock(clock);
  }

  /** Number of visible characters. */
  get length(): number {
    return this.#length;
  }

  /** Number of remote ops buffered because their dependencies haven't been integrated yet. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  toString(): string {
    const parts: string[] = [];
    for (let b: Block | null = this.#head; b; b = b.next) {
      for (const run of b.runs) if (!run.deleted) parts.push(run.text);
    }
    return parts.join('');
  }

  /** Insert `text` so that it starts at visible position `index`. Returns the ops to broadcast. */
  insert(index: number, text: string): InsertOp[] {
    assertIndex(index, this.#length, 'index');
    let origin = index === 0 ? ROOT : this.#idAtVisible(index - 1);
    const ops: InsertOp[] = [];
    for (let i = 0; i < text.length; i++) {
      // Each character's origin is the one before it, so a typed run forms one chain that
      // concurrent inserts elsewhere can't split, and that is stored as a single Run.
      const op: InsertOp = {
        type: 'insert',
        id: { clock: this.#clock.tick(), replica: this.replica },
        seq: ++this.#seq,
        origin,
        char: text.charAt(i),
      };
      this.#integrate(op);
      ops.push(op);
      origin = op.id;
    }
    return ops;
  }

  /** Delete `count` visible characters starting at `index`. Returns the ops to broadcast. */
  delete(index: number, count: number): DeleteOp[] {
    assertIndex(index, this.#length, 'index');
    assertIndex(count, this.#length - index, 'count');
    const targets = this.#idsAtVisible(index, count);
    return targets.map((target) => {
      const op: DeleteOp = {
        type: 'delete',
        id: { clock: this.#clock.tick(), replica: this.replica },
        seq: ++this.#seq,
        target,
      };
      this.#integrate(op);
      return op;
    });
  }

  /**
   * Integrate a remote op. Idempotent: an op already integrated or already buffered is a no-op.
   * Returns the ops integrated as a result, in integration order: `op` itself if it was ready,
   * plus any buffered ops it unblocked. Empty if `op` was a duplicate or had to be buffered.
   *
   * Trusts the op's shape; validate untrusted input with `parseOp` first.
   */
  apply(op: Op): Op[] {
    if (op.id.replica === this.replica) {
      // Our own op echoed back (e.g. by a server resending). Anything newer than our counter means
      // another live replica is using our ID, which would silently break convergence.
      if (op.seq <= this.#seq) return [];
      throw new InvalidOpError(
        `op ${String(op.seq)} claims this replica's ID but was never issued`,
      );
    }
    if (this.#isIntegrated(op) || this.#pending.has(op)) return [];
    if (op.type === 'insert' && this.#find(op.id)) {
      throw new InvalidOpError(`element ${op.id.replica}:${String(op.id.clock)} already exists`);
    }

    const integrated: Op[] = [];
    const ready: Op[] = [op];
    for (let next = ready.pop(); next; next = ready.pop()) {
      const blockedOn = this.#missingDependency(next);
      if (blockedOn) {
        this.#pending.add(next, blockedOn);
        continue;
      }
      this.#integrate(next);
      integrated.push(next);
      const { replica } = next.id;
      ready.push(...this.#pending.release({ kind: 'seq', replica, seq: next.seq }));
      if (next.type === 'insert') {
        ready.push(...this.#pending.release({ kind: 'element', id: next.id }));
      }
    }
    return integrated;
  }

  /** Apply ops in sequence; returns everything integrated as a result. */
  applyAll(ops: Iterable<Op>): Op[] {
    const integrated: Op[] = [];
    for (const op of ops) integrated.push(...this.apply(op));
    return integrated;
  }

  versionVector(): VersionVector {
    return Object.fromEntries(this.#vv);
  }

  /**
   * Integrated ops not covered by `vv`: what a peer with version vector `vv` is missing. Sorted by
   * ID, which is a causal order (every op's clock exceeds those of the ops it depends on), so the
   * receiver can integrate them without buffering.
   */
  opsSince(vv: VersionVector): Op[] {
    const out: Op[] = [];
    for (const [replica, runs] of this.#runsByReplica) {
      const from = vvGet(vv, replica);
      for (const run of runs) {
        if (run.seq + run.text.length - 1 <= from) continue;
        for (let k = Math.max(0, from - run.seq + 1); k < run.text.length; k++) {
          out.push({
            type: 'insert',
            id: { clock: run.clock + k, replica },
            seq: run.seq + k,
            origin: k === 0 ? run.origin : { clock: run.clock + k - 1, replica },
            char: run.text.charAt(k),
          });
        }
      }
    }
    for (const [replica, deletes] of this.#deletesByReplica) {
      const from = vvGet(vv, replica);
      for (const d of deletes) {
        if (d.seq + d.len - 1 <= from) continue;
        for (let k = Math.max(0, from - d.seq + 1); k < d.len; k++) {
          out.push({
            type: 'delete',
            id: { clock: d.clock + k, replica },
            seq: d.seq + k,
            target: { clock: d.target.clock + d.step * k, replica: d.target.replica },
          });
        }
      }
    }
    return out.sort((a, b) => compareIds(a.id, b.id));
  }

  /**
   * A stable reference to the gap before visible position `index`: the ID of the element just
   * left of it (ROOT for the start). Unlike an index, it stays correct as concurrent edits shift
   * text around, which is what remote cursors need.
   */
  anchorAt(index: number): Id {
    assertIndex(index, this.#length, 'index');
    return index === 0 ? ROOT : this.#idAtVisible(index - 1);
  }

  /**
   * Current visible position of an anchor from `anchorAt`. If the anchor element has since been
   * deleted, the position collapses onto where it was. Null if the element hasn't arrived yet.
   */
  indexOfAnchor(anchor: Id): number | null {
    if (isRoot(anchor)) return 0;
    const found = this.#find(anchor);
    if (!found) return null;
    const { run, offset } = found;
    let visible = 0;
    for (let b: Block | null = this.#head; b && b !== run.block; b = b.next) visible += b.visible;
    for (const r of run.block.runs) {
      if (r === run) break;
      if (!r.deleted) visible += r.text.length;
    }
    return visible + (run.deleted ? 0 : offset + 1);
  }

  stats(): DocStats {
    let runs = 0;
    let blocks = 0;
    for (let b: Block | null = this.#head; b; b = b.next) {
      blocks++;
      runs += b.runs.length;
    }
    let deleteRuns = 0;
    for (const d of this.#deletesByReplica.values()) deleteRuns += d.length;
    return {
      length: this.#length,
      chars: this.#chars,
      runs,
      blocks,
      deleteRuns,
      pending: this.#pending.size,
    };
  }

  /** Serialize all integrated state. Buffered (not yet integrated) ops are not included. */
  toSnapshot(): DocSnapshot {
    const replicas: ReplicaId[] = [];
    const indexOf = new Map<ReplicaId, number>();
    const intern = (r: ReplicaId) => {
      let i = indexOf.get(r);
      if (i === undefined) {
        i = replicas.push(r) - 1;
        indexOf.set(r, i);
      }
      return i;
    };
    const runs: DocSnapshot['runs'][number][] = [];
    for (let b: Block | null = this.#head; b; b = b.next) {
      for (const r of b.runs) {
        const origin = isRoot(r.origin) ? -1 : intern(r.origin.replica);
        runs.push([
          intern(r.replica),
          r.clock,
          r.seq,
          origin,
          r.origin.clock,
          r.text,
          r.deleted ? 1 : 0,
        ]);
      }
    }
    const deletes: DocSnapshot['deletes'][number][] = [];
    for (const [replica, list] of this.#deletesByReplica) {
      for (const d of list) {
        deletes.push([
          intern(replica),
          d.clock,
          d.seq,
          d.len,
          intern(d.target.replica),
          d.target.clock,
          d.step,
        ]);
      }
    }
    return { version: 1, clock: this.#clock.time, replicas, runs, deletes };
  }

  /**
   * Restore a document from a snapshot as a new replica. `replica` must not appear in the
   * snapshot: resuming an old replica ID risks reissuing seqs that other replicas already hold.
   */
  static fromSnapshot(snapshot: DocSnapshot, replica: ReplicaId): Doc {
    // Snapshots come from storage, which may hold data written by a different version.
    if ((snapshot.version as number) !== 1) throw new RangeError('unsupported snapshot version');
    if (snapshot.replicas.includes(replica)) {
      throw new RangeError(`replica ${replica} already appears in the snapshot; use a fresh ID`);
    }
    const doc = new Doc(replica, snapshot.clock);
    const replicaAt = (i: number): ReplicaId => {
      const r = snapshot.replicas[i];
      if (r === undefined) throw new RangeError(`snapshot references unknown replica ${String(i)}`);
      return r;
    };
    const vv = doc.#vv;
    const seen = (r: ReplicaId, lastSeq: number) => {
      if (lastSeq > (vv.get(r) ?? 0)) vv.set(r, lastSeq);
    };

    let block = doc.#head;
    for (const [ri, clock, seq, oi, originClock, text, deleted] of snapshot.runs) {
      if (block.runs.length >= MAX_BLOCK_RUNS / 2) {
        const next: Block = { runs: [], visible: 0, prev: block, next: null };
        block.next = next;
        block = next;
      }
      const r = replicaAt(ri);
      const origin = oi === -1 ? ROOT : { clock: originClock, replica: replicaAt(oi) };
      const run: Run = { replica: r, clock, seq, origin, text, deleted: deleted === 1, block };
      block.runs.push(run);
      doc.#chars += text.length;
      if (!run.deleted) {
        block.visible += text.length;
        doc.#length += text.length;
      }
      let list = doc.#runsByReplica.get(r);
      if (!list) doc.#runsByReplica.set(r, (list = []));
      list.push(run);
      seen(r, seq + text.length - 1);
    }
    for (const list of doc.#runsByReplica.values()) list.sort((a, b) => a.clock - b.clock);

    for (const [ri, clock, seq, len, ti, targetClock, step] of snapshot.deletes) {
      const r = replicaAt(ri);
      let list = doc.#deletesByReplica.get(r);
      if (!list) doc.#deletesByReplica.set(r, (list = []));
      list.push({ clock, seq, len, target: { clock: targetClock, replica: replicaAt(ti) }, step });
      seen(r, seq + len - 1);
    }
    for (const list of doc.#deletesByReplica.values()) list.sort((a, b) => a.seq - b.seq);
    return doc;
  }

  #isIntegrated(op: Op): boolean {
    return (this.#vv.get(op.id.replica) ?? 0) >= op.seq;
  }

  #missingDependency(op: Op): Dependency | null {
    const { replica } = op.id;
    const previous = op.seq - 1;
    if ((this.#vv.get(replica) ?? 0) < previous) return { kind: 'seq', replica, seq: previous };
    const ref = op.type === 'insert' ? op.origin : op.target;
    if (!isRoot(ref) && !this.#find(ref)) return { kind: 'element', id: ref };
    return null;
  }

  /** Integrate an op whose dependencies are all present. */
  #integrate(op: Op): void {
    this.#clock.observe(op.id.clock);
    this.#vv.set(op.id.replica, op.seq);
    if (op.type === 'insert') this.#integrateInsert(op);
    else this.#integrateDelete(op);
  }

  /**
   * The RGA rule. Conceptually each element is a child of its origin, siblings are ordered by ID
   * descending, and the document is a depth-first walk of that tree. In the flat sequence that
   * becomes: start just right of the origin and skip every element with a greater ID than ours.
   *
   * Why skipping by ID alone is enough: an element we skip is either a newer sibling or something
   * inserted (transitively) after one. The latter were created by replicas that had seen that
   * sibling, so by the Lamport property their clocks are larger still. The scan therefore skips
   * whole subtrees of newer siblings, and stops at the first older sibling or at the end of the
   * origin's subtree, whose following elements are all older than the origin and hence than us.
   *
   * Over runs the same scan works a run at a time: IDs increase along a run, so if a run's first
   * character is newer than ours, all of it is.
   */
  #integrateInsert(op: InsertOp): void {
    let block: Block;
    let index: number;
    if (isRoot(op.origin)) {
      block = this.#head;
      index = 0;
    } else {
      const { run, offset } = this.#mustFind(op.origin);
      block = run.block;
      index = block.runs.indexOf(run);
      if (offset < run.text.length - 1) {
        // The origin's right neighbour is the next character of its own run.
        if (compare(run.clock + offset + 1, run.replica, op.id) < 0) {
          // That neighbour is older than us, so we go directly between them.
          this.#splitRun(run, offset + 1);
          this.#insertAt(block, index + 1, op);
          return;
        }
      }
      index++;
    }
    for (;;) {
      const run = block.runs[index];
      if (!run) {
        if (!block.next) break;
        block = block.next;
        index = 0;
        continue;
      }
      if (compare(run.clock, run.replica, op.id) < 0) break;
      index++;
    }
    this.#insertAt(block, index, op);
  }

  /** Place a new character before `block.runs[index]`, extending the preceding run if possible. */
  #insertAt(block: Block, index: number, op: InsertOp): void {
    this.#length++;
    this.#chars++;
    const prev = index > 0 ? block.runs[index - 1] : block.prev?.runs.at(-1);
    if (prev && extendsRun(prev, op)) {
      prev.text += op.char;
      prev.block.visible++;
      return;
    }
    const run: Run = {
      replica: op.id.replica,
      clock: op.id.clock,
      seq: op.seq,
      origin: op.origin,
      text: op.char,
      deleted: false,
      block,
    };
    block.runs.splice(index, 0, run);
    block.visible++;
    this.#indexRun(run);
    if (block.runs.length > MAX_BLOCK_RUNS) this.#splitBlock(block);
  }

  /** Tombstone the target. Deleting twice (concurrent deletes of one char) is a no-op. */
  #integrateDelete(op: DeleteOp): void {
    this.#recordDelete(op);
    const found = this.#mustFind(op.target);
    if (found.run.deleted) return;
    let { run } = found;
    const { block } = run;
    if (found.offset > 0) run = this.#splitRun(run, found.offset);
    if (run.text.length > 1) this.#splitRun(run, 1);
    run.deleted = true;
    block.visible--;
    this.#length--;
    this.#mergeNeighbours(run);
    if (block.runs.length > MAX_BLOCK_RUNS) this.#splitBlock(block);
  }

  #recordDelete(op: DeleteOp): void {
    const { replica } = op.id;
    let list = this.#deletesByReplica.get(replica);
    if (!list) this.#deletesByReplica.set(replica, (list = []));
    const last = list.at(-1);
    if (
      last &&
      last.clock + last.len === op.id.clock &&
      last.seq + last.len === op.seq &&
      last.target.replica === op.target.replica
    ) {
      const delta = op.target.clock - (last.target.clock + last.step * (last.len - 1));
      if ((last.len === 1 && Math.abs(delta) === 1) || (last.len > 1 && delta === last.step)) {
        last.step = delta;
        last.len++;
        return;
      }
    }
    list.push({ clock: op.id.clock, seq: op.seq, len: 1, target: op.target, step: 0 });
  }

  /** Split `run` before character `at`; returns the new right-hand run (same block, right after). */
  #splitRun(run: Run, at: number): Run {
    const right: Run = {
      replica: run.replica,
      clock: run.clock + at,
      seq: run.seq + at,
      origin: { clock: run.clock + at - 1, replica: run.replica },
      text: run.text.slice(at),
      deleted: run.deleted,
      block: run.block,
    };
    run.text = run.text.slice(0, at);
    const { runs } = run.block;
    runs.splice(runs.indexOf(run) + 1, 0, right);
    this.#indexRun(right);
    return right;
  }

  /** Re-join a run with same-block neighbours it was split from, once their flags match again. */
  #mergeNeighbours(run: Run): void {
    const { runs } = run.block;
    const i = runs.indexOf(run);
    const next = runs[i + 1];
    if (next && continuesRun(run, next)) {
      run.text += next.text;
      runs.splice(i + 1, 1);
      this.#unindexRun(next);
    }
    const prev = runs[i - 1];
    if (prev && continuesRun(prev, run)) {
      prev.text += run.text;
      runs.splice(i, 1);
      this.#unindexRun(run);
    }
  }

  #splitBlock(block: Block): void {
    const moved = block.runs.splice(block.runs.length >>> 1);
    const next: Block = { runs: moved, visible: 0, prev: block, next: block.next };
    if (block.next) block.next.prev = next;
    block.next = next;
    for (const run of moved) {
      run.block = next;
      if (!run.deleted) next.visible += run.text.length;
    }
    block.visible -= next.visible;
  }

  #indexRun(run: Run): void {
    let list = this.#runsByReplica.get(run.replica);
    if (!list) this.#runsByReplica.set(run.replica, (list = []));
    const last = list.at(-1);
    if (!last || last.clock < run.clock) list.push(run);
    else list.splice(upperBound(list, run.clock), 0, run);
  }

  #unindexRun(run: Run): void {
    const list = this.#runsByReplica.get(run.replica);
    if (!list) return;
    const i = upperBound(list, run.clock) - 1;
    if (list[i] === run) list.splice(i, 1);
  }

  #find(id: Id): { run: Run; offset: number } | undefined {
    const list = this.#runsByReplica.get(id.replica);
    if (!list) return undefined;
    const run = list[upperBound(list, id.clock) - 1];
    if (!run) return undefined;
    const offset = id.clock - run.clock;
    return offset < run.text.length ? { run, offset } : undefined;
  }

  #mustFind(id: Id): { run: Run; offset: number } {
    const found = this.#find(id);
    if (!found) throw new Error(`invariant: element ${id.replica}:${String(id.clock)} missing`);
    return found;
  }

  #idAtVisible(index: number): Id {
    return this.#idsAtVisible(index, 1)[0] ?? ROOT;
  }

  /** IDs of `count` visible characters starting at visible position `index`. */
  #idsAtVisible(index: number, count: number): Id[] {
    const ids: Id[] = [];
    let skip = index;
    let block: Block | null = this.#head;
    while (block && skip >= block.visible) {
      skip -= block.visible;
      block = block.next;
    }
    for (; block && ids.length < count; block = block.next) {
      for (const run of block.runs) {
        if (run.deleted) continue;
        const len = run.text.length;
        if (skip >= len) {
          skip -= len;
          continue;
        }
        for (let k = skip; k < len && ids.length < count; k++) {
          ids.push({ clock: run.clock + k, replica: run.replica });
        }
        skip = 0;
        if (ids.length === count) break;
      }
    }
    return ids;
  }
}

/** compareIds((clock, replica), id) without allocating an Id. */
function compare(clock: number, replica: ReplicaId, id: Id): number {
  if (clock !== id.clock) return clock < id.clock ? -1 : 1;
  if (replica === id.replica) return 0;
  return replica < id.replica ? -1 : 1;
}

/** Can `op` be stored as the next character of `run`? */
function extendsRun(run: Run, op: InsertOp): boolean {
  const end = run.clock + run.text.length;
  return (
    !run.deleted &&
    run.replica === op.id.replica &&
    end === op.id.clock &&
    run.seq + run.text.length === op.seq &&
    op.origin.replica === run.replica &&
    op.origin.clock === end - 1
  );
}

/** Is `b` the continuation of `a` (as if never split), with the same tombstone flag? */
function continuesRun(a: Run, b: Run): boolean {
  const end = a.clock + a.text.length;
  return (
    a.deleted === b.deleted &&
    a.replica === b.replica &&
    end === b.clock &&
    a.seq + a.text.length === b.seq &&
    b.origin.replica === a.replica &&
    b.origin.clock === end - 1
  );
}

/** Index of the first run with clock > `clock`, in a list sorted by clock. */
function upperBound(list: readonly Run[], clock: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const run = list[mid];
    if (run && run.clock <= clock) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function assertIndex(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} ${String(value)} out of range [0, ${String(max)}]`);
  }
}
