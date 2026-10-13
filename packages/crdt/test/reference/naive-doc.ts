import { LamportClock } from '../../src/clock.ts';
import {
  compareIds,
  idKey,
  isReplicaId,
  isRoot,
  ROOT,
  type Id,
  type ReplicaId,
} from '../../src/id.ts';
import { InvalidOpError, type DeleteOp, type InsertOp, type Op } from '../../src/ops.ts';
import { PendingBuffer, type Dependency } from '../../src/pending.ts';
import { vvCovers, type VersionVector } from '../../src/version-vector.ts';

interface Item {
  readonly id: Id;
  readonly origin: Id;
  readonly char: string;
  deleted: boolean;
}

/**
 * The original, deliberately simple implementation, frozen as a reference: a flat array of
 * per-character items with O(n) position lookups. It is the test oracle for the optimized `Doc`
 * (differential property tests) and the "before" column of the benchmarks.
 *
 * A replicated text document: an RGA (Replicated Growable Array) sequence CRDT.
 *
 * Every character ever inserted is an element with a unique ID; deletes only mark elements as
 * tombstones, so positions referenced by concurrent ops stay valid. Replicas that have integrated
 * the same set of ops have identical element sequences, whatever order the ops arrived in.
 *
 * Local edits (`insert`, `delete`) are applied immediately and return the ops to broadcast.
 * Remote ops go through `apply`, which is idempotent and accepts any delivery order: ops whose
 * dependencies haven't arrived are buffered until they do.
 */
export class NaiveDoc {
  readonly replica: ReplicaId;
  readonly #clock = new LamportClock();
  #seq = 0;
  /** All elements, tombstones included, in document order. */
  readonly #items: Item[] = [];
  readonly #byId = new Map<string, Item>();
  /** Highest contiguous seq integrated per replica. */
  readonly #vv = new Map<ReplicaId, number>();
  /** Integrated ops in integration order, which is causally consistent. */
  readonly #log: Op[] = [];
  readonly #pending = new PendingBuffer();
  #length = 0;

  constructor(replica: ReplicaId) {
    if (!isReplicaId(replica))
      throw new RangeError(`invalid replica ID: ${JSON.stringify(replica)}`);
    this.replica = replica;
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
    const chars: string[] = [];
    for (const item of this.#items) if (!item.deleted) chars.push(item.char);
    return chars.join('');
  }

  /** Insert `text` so that it starts at visible position `index`. Returns the ops to broadcast. */
  insert(index: number, text: string): InsertOp[] {
    assertIndex(index, this.#length, 'index');
    let origin = index === 0 ? ROOT : this.#visibleItemAt(index - 1).id;
    const ops: InsertOp[] = [];
    for (let i = 0; i < text.length; i++) {
      // Each character's origin is the one before it, so a typed run forms one chain that
      // concurrent inserts elsewhere can't split.
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
    const targets: Id[] = [];
    let visible = 0;
    for (const item of this.#items) {
      if (item.deleted) continue;
      if (visible >= index + count) break;
      if (visible >= index) targets.push(item.id);
      visible++;
    }
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
    if (op.type === 'insert' && this.#byId.has(idKey(op.id))) {
      throw new InvalidOpError(`element ${idKey(op.id)} already exists under a different seq`);
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
   * Integrated ops not covered by `vv`, in an order that can be applied without buffering.
   * This is what a peer with version vector `vv` is missing.
   */
  opsSince(vv: VersionVector): Op[] {
    return this.#log.filter((op) => !vvCovers(vv, op.id.replica, op.seq));
  }

  /**
   * A stable reference to the gap before visible position `index`: the ID of the element just
   * left of it (ROOT for the start). Unlike an index, it stays correct as concurrent edits shift
   * text around, which is what remote cursors need.
   */
  anchorAt(index: number): Id {
    assertIndex(index, this.#length, 'index');
    return index === 0 ? ROOT : this.#visibleItemAt(index - 1).id;
  }

  /**
   * Current visible position of an anchor from `anchorAt`. If the anchor element has since been
   * deleted, the position collapses onto where it was. Null if the element hasn't arrived yet.
   */
  indexOfAnchor(anchor: Id): number | null {
    if (isRoot(anchor)) return 0;
    const target = this.#byId.get(idKey(anchor));
    if (!target) return null;
    // The gap after `target` sits after every visible element up to and including it.
    let visible = 0;
    for (const item of this.#items) {
      if (!item.deleted) visible++;
      if (item === target) return visible;
    }
    throw new Error(`invariant: element ${idKey(anchor)} indexed but not in sequence`);
  }

  #isIntegrated(op: Op): boolean {
    return (this.#vv.get(op.id.replica) ?? 0) >= op.seq;
  }

  #missingDependency(op: Op): Dependency | null {
    const { replica } = op.id;
    const previous = op.seq - 1;
    if ((this.#vv.get(replica) ?? 0) < previous) return { kind: 'seq', replica, seq: previous };
    const ref = op.type === 'insert' ? op.origin : op.target;
    if (!isRoot(ref) && !this.#byId.has(idKey(ref))) return { kind: 'element', id: ref };
    return null;
  }

  /** Integrate an op whose dependencies are all present. */
  #integrate(op: Op): void {
    this.#clock.observe(op.id.clock);
    this.#vv.set(op.id.replica, op.seq);
    this.#log.push(op);
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
   */
  #integrateInsert(op: InsertOp): void {
    let i = isRoot(op.origin) ? 0 : this.#indexOfId(op.origin) + 1;
    for (let next = this.#items[i]; next && compareIds(next.id, op.id) > 0; next = this.#items[i]) {
      i++;
    }
    const item: Item = { id: op.id, origin: op.origin, char: op.char, deleted: false };
    this.#items.splice(i, 0, item);
    this.#byId.set(idKey(op.id), item);
    this.#length++;
  }

  /** Tombstone the target. Deleting twice (concurrent deletes of one char) is a no-op. */
  #integrateDelete(op: DeleteOp): void {
    const item = this.#byId.get(idKey(op.target));
    if (!item) throw new Error(`invariant: delete target ${idKey(op.target)} missing`);
    if (item.deleted) return;
    item.deleted = true;
    this.#length--;
  }

  #indexOfId(id: Id): number {
    const item = this.#byId.get(idKey(id));
    if (!item) throw new Error(`invariant: element ${idKey(id)} missing`);
    return this.#items.indexOf(item);
  }

  #visibleItemAt(index: number): Item {
    let visible = 0;
    for (const item of this.#items) {
      if (item.deleted) continue;
      if (visible === index) return item;
      visible++;
    }
    throw new RangeError(`index ${String(index)} out of range`);
  }
}

function assertIndex(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} ${String(value)} out of range [0, ${String(max)}]`);
  }
}
