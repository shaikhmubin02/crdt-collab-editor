import { vvGet, type Doc, type Op, type ReplicaId, type VersionVector } from '@collab/crdt';
import { CloseCode, MAX_OPS_PER_FRAME, type Cursor } from '@collab/protocol';
import type { Connection } from './connection.ts';
import type { Fanout, FanoutMessage } from './fanout.ts';
import type { Logger } from './log.ts';
import type { Metrics } from './metrics.ts';
import { materialize } from './store/snapshot-builder.ts';
import type { DocStore } from './store/store.ts';

/** The server's replica ID. Servers integrate ops but never issue any. */
export const SERVER_REPLICA = '_server';

export interface RoomDeps {
  readonly store: DocStore;
  readonly metrics: Metrics;
  readonly log: Logger;
  /** Take a snapshot after this many ops have been appended since the last one. */
  readonly snapshotEvery: number;
  readonly fanout: Fanout | null;
  /** Called if the room gives up (storage unavailable) so the server can forget it. */
  readonly onFailed: (room: Room) => void;
}

interface PendingWrite {
  readonly ops: readonly Op[];
  readonly from: Connection | null;
  readonly trace: number | undefined;
}

const APPEND_RETRY_DELAYS_MS = [50, 200, 500, 1000, 2000, 4000];

/**
 * One document's live session on this server: the authoritative in-memory replica, its clients,
 * and the pipeline client ops → integrate → persist → broadcast + ack.
 *
 * Integration is synchronous (the Doc dedups, buffers early ops and orders them causally). Writes
 * are group-committed: while one append is in flight, newly integrated ops queue up and go out in
 * the next append. An op is broadcast and acknowledged only after it is durable, so an ack is a
 * promise the server won't forget it, and every client sees ops in an order the server persisted.
 */
export class Room {
  readonly id: string;
  readonly doc: Doc;
  readonly clients = new Set<Connection>();
  readonly #deps: RoomDeps;
  /** Per replica, the highest seq known to be durable (ours or another instance's). */
  readonly #persisted = new Map<ReplicaId, number>();
  #writes: PendingWrite[] = [];
  #flushing: Promise<void> | null = null;
  #opsSinceSnapshot: number;
  #compacting: Promise<void> | null = null;
  #failed = false;
  #unsubscribe: (() => Promise<void>) | null = null;

  private constructor(id: string, doc: Doc, opsSinceSnapshot: number, deps: RoomDeps) {
    this.id = id;
    this.doc = doc;
    this.#deps = deps;
    this.#opsSinceSnapshot = opsSinceSnapshot;
    for (const [replica, seq] of Object.entries(doc.versionVector()))
      this.#persisted.set(replica, seq);
  }

  static async load(id: string, deps: RoomDeps): Promise<Room> {
    const started = performance.now();
    // Subscribe before reading storage, so ops persisted by another instance in between arrive
    // by one path or the other (both are idempotent).
    const early: FanoutMessage[] = [];
    let room: Room | null = null;
    const unsubscribe = deps.fanout
      ? await deps.fanout.subscribe(id, (m) => {
          if (room) room.#onFanout(m);
          else early.push(m);
        })
      : null;
    const stored = await deps.store.load(id);
    const doc = materialize(stored.snapshot, stored.ops, SERVER_REPLICA);
    room = new Room(id, doc, stored.ops.length, deps);
    room.#unsubscribe = unsubscribe;
    for (const m of early) room.#onFanout(m);
    deps.metrics.observe('sync_room_load_ms', performance.now() - started);
    deps.log.log('info', 'room loaded', {
      doc: id,
      snapshot: stored.snapshot !== null,
      replayedOps: stored.ops.length,
      ms: Math.round(performance.now() - started),
    });
    return room;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** Admit a client: send everything it's missing, the server's version vector and who's here. */
  join(conn: Connection, clientVv: VersionVector): void {
    for (const other of this.clients) {
      if (other.replica === conn.replica) other.close(CloseCode.Replaced, 'replica reconnected');
    }
    this.clients.add(conn);
    const peers = [...this.clients].flatMap((c) => (c !== conn && c.peer ? [c.peer] : []));
    const vv = this.doc.versionVector();
    if (Object.keys(clientVv).length === 0) {
      conn.send({ type: 'welcome', vv, snapshot: this.doc.toSnapshot(), ops: [], peers });
    } else {
      const missing = this.doc.opsSince(clientVv);
      conn.send({
        type: 'welcome',
        vv,
        snapshot: null,
        ops: missing.slice(0, MAX_OPS_PER_FRAME),
        peers,
      });
      for (let i = MAX_OPS_PER_FRAME; i < missing.length; i += MAX_OPS_PER_FRAME) {
        conn.send({ type: 'ops', ops: missing.slice(i, i + MAX_OPS_PER_FRAME) });
      }
    }
    this.#announce(conn);
  }

  leave(conn: Connection): void {
    if (!this.clients.delete(conn) || !conn.replica) return;
    for (const c of this.clients) c.sendPresence(conn.replica, null);
    this.#deps.fanout?.publish(this.id, { kind: 'leave', replica: conn.replica });
  }

  receiveOps(conn: Connection, ops: readonly Op[], trace: number | undefined): void {
    if (this.#failed) return;
    this.#deps.metrics.inc('sync_ops_received_total', ops.length);
    // May include previously buffered ops (from anyone) that these ops unblocked.
    const integrated = this.doc.applyAll(ops);
    // Queue even an empty write, so the sender is acked (e.g. a resend of ops we already have)
    // after everything before it is durable.
    this.#writes.push({ ops: integrated, from: conn, trace });
    this.#scheduleFlush();
  }

  receivePresence(conn: Connection, cursor: Cursor | null): void {
    conn.cursor = cursor;
    this.#announce(conn);
  }

  /** Wait until every integrated op has been persisted. */
  async drain(): Promise<void> {
    while (this.#flushing) await this.#flushing;
  }

  /** Persist outstanding writes, snapshot if anything changed since the last one, stop relaying. */
  async close(): Promise<void> {
    await this.drain();
    await this.#compacting;
    if (this.#opsSinceSnapshot > 0 && !this.#failed) await this.#compact();
    await this.#unsubscribe?.();
  }

  #announce(conn: Connection): void {
    const peer = conn.peer;
    if (!peer) return;
    for (const c of this.clients) if (c !== conn) c.sendPresence(peer.replica, peer);
    this.#deps.fanout?.publish(this.id, { kind: 'presence', peer });
  }

  #scheduleFlush(): void {
    this.#flushing ??= this.#flushLoop().finally(() => {
      this.#flushing = null;
    });
  }

  async #flushLoop(): Promise<void> {
    const { metrics } = this.#deps;
    while (this.#writes.length > 0 && !this.#failed) {
      const batch = this.#writes;
      this.#writes = [];
      const ops = batch.flatMap((w) => w.ops);
      if (ops.length > 0) {
        const started = performance.now();
        if (!(await this.#appendWithRetry(ops))) return;
        metrics.observe('sync_persist_ms', performance.now() - started);
        metrics.inc('sync_persist_batches_total');
        metrics.inc('sync_ops_persisted_total', ops.length);
        this.#markPersisted(ops);
      }

      const traces = batch.flatMap((w) => (w.trace === undefined ? [] : [w.trace]));
      this.#broadcast(ops, (c) =>
        batch.filter((w) => w.from !== c && w.trace !== undefined).map((w) => w.trace ?? 0),
      );
      for (const conn of this.clients) {
        if (batch.some((w) => w.from === conn) || ops.some((op) => owns(conn, op.id.replica))) {
          conn.send({ type: 'ack', vv: this.#ackFor(conn) });
        }
      }
      if (ops.length > 0) this.#deps.fanout?.publish(this.id, { kind: 'ops', ops, traces });

      this.#opsSinceSnapshot += ops.length;
      if (this.#opsSinceSnapshot >= this.#deps.snapshotEvery) {
        this.#compacting ??= this.#compact().finally(() => {
          this.#compacting = null;
        });
      }
    }
  }

  /** Send each client the ops it doesn't own (it already has its own). */
  #broadcast(ops: readonly Op[], tracesFor: (c: Connection) => number[] = () => []): void {
    if (ops.length === 0) return;
    for (const conn of this.clients) {
      const theirs = ops.filter((op) => !owns(conn, op.id.replica));
      if (theirs.length === 0) continue;
      const traces = tracesFor(conn);
      this.#deps.metrics.inc('sync_ops_broadcast_total', theirs.length);
      conn.send(
        traces.length > 0 ? { type: 'ops', ops: theirs, traces } : { type: 'ops', ops: theirs },
      );
    }
  }

  #ackFor(conn: Connection): VersionVector {
    const vv: Record<ReplicaId, number> = {};
    for (const replica of [conn.replica, ...conn.owns]) {
      if (replica) vv[replica] = this.#persisted.get(replica) ?? 0;
    }
    return vv;
  }

  #markPersisted(ops: readonly Op[]): void {
    for (const op of ops) {
      if (op.seq > (this.#persisted.get(op.id.replica) ?? 0))
        this.#persisted.set(op.id.replica, op.seq);
    }
  }

  async #appendWithRetry(ops: readonly Op[]): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#deps.store.append(this.id, ops);
        return true;
      } catch (error) {
        const delay = APPEND_RETRY_DELAYS_MS[attempt];
        this.#deps.metrics.inc('sync_persist_errors_total');
        this.#deps.log.log('warn', 'append failed', {
          doc: this.id,
          attempt,
          error: String(error),
        });
        if (delay === undefined) {
          this.#fail();
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Storage is gone. Drop the room and disconnect everyone: unacknowledged ops are still in the
   * clients' outboxes and will be re-sent when they reconnect to a healthy room.
   */
  #fail(): void {
    this.#failed = true;
    this.#writes = [];
    this.#deps.log.log('error', 'room failed: storage unavailable', { doc: this.id });
    for (const conn of this.clients) conn.close(1011, 'storage unavailable');
    this.clients.clear();
    this.#deps.onFailed(this);
    void this.#unsubscribe?.();
  }

  async #compact(): Promise<void> {
    const started = performance.now();
    try {
      const result = await this.#deps.store.compact(this.id);
      this.#opsSinceSnapshot = 0;
      if (result) {
        this.#deps.metrics.inc('sync_snapshots_total');
        this.#deps.log.log('info', 'snapshot taken', {
          doc: this.id,
          ...result,
          ms: Math.round(performance.now() - started),
        });
      }
    } catch (error) {
      this.#deps.log.log('error', 'snapshot failed', { doc: this.id, error: String(error) });
    }
  }

  /** Message from another instance hosting this document. */
  #onFanout(message: FanoutMessage): void {
    switch (message.kind) {
      case 'ops': {
        // Durable already (the publishing instance persisted them first).
        this.#markPersisted(message.ops);
        const fromPeer = new Set(message.ops.map(opKey));
        const integrated = this.doc.applyAll(message.ops);
        this.#broadcast(integrated, () => [...message.traces]);
        // Ops of ours that were buffered here and just got unblocked still need persisting.
        const ours = integrated.filter((op) => !fromPeer.has(opKey(op)));
        if (ours.length > 0) {
          this.#writes.push({ ops: ours, from: null, trace: undefined });
          this.#scheduleFlush();
        }
        break;
      }
      case 'presence':
        for (const c of this.clients) c.sendPresence(message.peer.replica, message.peer);
        break;
      case 'leave':
        for (const c of this.clients) c.sendPresence(message.replica, null);
        break;
    }
  }

  /** Persisted seq for a replica (test/diagnostic helper). */
  persistedSeq(replica: ReplicaId): number {
    return vvGet(Object.fromEntries(this.#persisted), replica);
  }
}

function owns(conn: Connection, replica: ReplicaId): boolean {
  return conn.replica === replica || conn.owns.has(replica);
}

function opKey(op: Op): string {
  return `${op.id.replica}|${String(op.seq)}`;
}
