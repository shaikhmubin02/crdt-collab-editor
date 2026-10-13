import type { Op, ReplicaId } from '@collab/crdt';
import {
  CloseCode,
  encode,
  MAX_OPS_PER_FRAME,
  type Cursor,
  type Peer,
  type ServerMessage,
  type User,
} from '@collab/protocol';
import type { WebSocket } from 'ws';
import type { Metrics } from './metrics.ts';

export interface BackpressureConfig {
  /** Stop writing to a socket while it has more than this many bytes buffered. */
  readonly highWaterBytes: number;
  /** Disconnect a client whose undelivered op backlog exceeds this. */
  readonly maxQueuedOps: number;
  /**
   * Disconnect a backed-up client whose socket has made no write progress for this long.
   * "No progress", not "backlog non-empty": a healthy client draining a large burst has a backlog
   * for seconds but keeps completing writes; a client that stopped reading completes none.
   */
  readonly maxStallMs: number;
}

/** How long a closing socket gets to finish the close handshake before it is terminated. */
const CLOSE_GRACE_MS = 2000;

type Reliable = Exclude<ServerMessage, { type: 'presence' } | { type: 'leave' }>;

/**
 * One client connection, and the policy for clients that can't keep up.
 *
 * Reliable messages (welcome, ops, ack) go through an ordered queue that is only written to the
 * socket while its buffered amount is under the high-water mark, so one slow client costs bounded
 * kernel/userland buffer instead of the whole server's memory. While backed up, queued op frames
 * are coalesced into larger ones. A backed-up client whose socket stops making progress, or whose
 * backlog grows too large, is disconnected with SlowConsumer. That's safe: on reconnect it sends its version
 * vector and receives exactly what it missed, so dropping a connection never drops data.
 *
 * Presence is best-effort: only the latest state per peer is kept, and it is sent only when the
 * reliable queue is empty.
 */
export class Connection {
  readonly socket: WebSocket;
  replica: ReplicaId | null = null;
  /** Replica IDs whose ops this connection may upload. */
  readonly owns = new Set<ReplicaId>();
  user: User | null = null;
  cursor: Cursor | null = null;

  readonly #config: BackpressureConfig;
  readonly #metrics: Metrics;
  readonly #queue: Reliable[] = [];
  #queuedOps = 0;
  readonly #presence = new Map<ReplicaId, Peer | null>();
  /** A write completed since the last tick. */
  #progressed = false;
  /** Consecutive backed-up ticks without progress. */
  #stalledMs = 0;
  #closed = false;

  constructor(socket: WebSocket, config: BackpressureConfig, metrics: Metrics) {
    this.socket = socket;
    this.#config = config;
    this.#metrics = metrics;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get peer(): Peer | null {
    if (!this.replica || !this.user) return null;
    return { replica: this.replica, user: this.user, cursor: this.cursor };
  }

  /** Undelivered ops queued for this client (not counting bytes already in the socket buffer). */
  get backlog(): number {
    return this.#queuedOps;
  }

  send(message: Reliable): void {
    if (this.#closed) return;
    if (message.type === 'ops') {
      if (message.ops.length === 0) return;
      this.#queuedOps += message.ops.length;
    }
    this.#queue.push(message);
    if (this.#queuedOps > this.#config.maxQueuedOps) {
      this.close(CloseCode.SlowConsumer, 'backlog too large');
      return;
    }
    this.flush();
  }

  /** Queue a presence update; supersedes any undelivered update for the same peer. */
  sendPresence(replica: ReplicaId, peer: Peer | null): void {
    if (this.#closed) return;
    this.#presence.set(replica, peer);
    this.flush();
  }

  /** Write as much queued data as the socket's buffer allows. */
  flush(): void {
    if (this.#closed) return;
    const { highWaterBytes } = this.#config;
    while (this.#queue.length > 0 && this.socket.bufferedAmount < highWaterBytes) {
      const next = this.#takeFrame();
      this.socket.send(encode(next), this.#onWritten);
    }
    for (const [replica, peer] of this.#presence) {
      if (this.#queue.length > 0 || this.socket.bufferedAmount >= highWaterBytes) break;
      this.#presence.delete(replica);
      this.socket.send(encode(peer ? { type: 'presence', peer } : { type: 'leave', replica }));
    }
  }

  /**
   * Called on a fixed timer. Stall time is counted in ticks, not wall-clock time: if this process's
   * event loop is blocked (GC, a CPU spike), write callbacks can't run, but neither can ticks, so
   * the server's own pauses are never blamed on the client.
   */
  tick(elapsedMs: number): void {
    if (this.#closed) return;
    this.flush();
    if (this.#queue.length === 0 || this.#progressed) {
      this.#stalledMs = 0;
    } else {
      this.#stalledMs += elapsedMs;
      if (this.#stalledMs >= this.#config.maxStallMs)
        this.close(CloseCode.SlowConsumer, 'not reading');
    }
    this.#progressed = false;
  }

  /** Called once when the connection closes, from either side; the server uses it to leave the room. */
  onClose: (() => void) | null = null;

  /**
   * Close and leave the room immediately. The close frame queues behind any buffered data, which a
   * client that isn't reading will never consume, so the socket is terminated if the close
   * handshake hasn't finished shortly after.
   */
  close(code: number, reason: string): void {
    if (this.#closed) return;
    if (code === CloseCode.SlowConsumer) this.#metrics.inc('sync_slow_consumer_disconnects_total');
    this.markClosed();
    this.#queue.length = 0;
    this.#queuedOps = 0;
    this.#presence.clear();
    this.socket.close(code, reason);
    setTimeout(() => {
      this.socket.terminate();
    }, CLOSE_GRACE_MS).unref();
  }

  /** Mark closed (idempotent), e.g. after the socket closed on its own. */
  markClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.onClose?.();
  }

  readonly #onWritten = (err?: Error) => {
    if (err) return;
    this.#progressed = true;
    this.flush();
  };

  /** Pop the next frame, merging consecutive queued op batches (up to the frame limit). */
  #takeFrame(): Reliable {
    const first = this.#queue.shift();
    if (!first) throw new Error('invariant: empty queue');
    if (first.type !== 'ops') return first;
    let ops: Op[] = [...first.ops];
    let traces: number[] = [...(first.traces ?? [])];
    for (let next = this.#queue[0]; next?.type === 'ops'; next = this.#queue[0]) {
      if (ops.length + next.ops.length > MAX_OPS_PER_FRAME) break;
      this.#queue.shift();
      ops = ops.concat(next.ops);
      traces = traces.concat(next.traces ?? []);
    }
    this.#queuedOps -= ops.length;
    return traces.length > 0 ? { type: 'ops', ops, traces } : { type: 'ops', ops };
  }
}
