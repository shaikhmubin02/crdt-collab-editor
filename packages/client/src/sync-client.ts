import { Doc, vvGet, type Id, type Op, type ReplicaId, type VersionVector } from '@collab/crdt';
import {
  encode,
  MAX_OPS_PER_FRAME,
  parseServerMessage,
  PROTOCOL_VERSION,
  type Cursor,
  type Peer,
  type ServerMessage,
  type User,
} from '@collab/protocol';
import type { ClientStorage } from './storage.ts';

/** The subset of the WebSocket API the client uses (browser WebSocket and Node's global one). */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type Status = 'connecting' | 'online' | 'offline';

/** A peer's selection resolved to current visible indices (null if not resolvable yet). */
export interface PeerView {
  readonly replica: ReplicaId;
  readonly user: User;
  readonly selection: { readonly anchor: number; readonly head: number } | null;
}

export interface ChangeEvent {
  /** True if caused by ops from other replicas. */
  readonly remote: boolean;
  readonly ops: readonly Op[];
}

export interface SyncClientOptions {
  readonly url: string;
  readonly docId: string;
  readonly user: User;
  readonly storage: ClientStorage;
  /** Defaults to the global WebSocket. */
  readonly connect?: (url: string) => SocketLike;
  /** Defaults to a random ID. Must never be reused across sessions. */
  readonly replica?: ReplicaId;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly snapshotDebounceMs?: number;
  readonly presenceThrottleMs?: number;
}

const OPEN = 1;

interface Events {
  change: ChangeEvent;
  status: Status;
  presence: undefined;
}

/**
 * A document replica that stays usable offline.
 *
 * Every local edit is applied to the in-memory Doc immediately, appended to the durable outbox and,
 * if connected, sent. On (re)connect the client and server exchange version vectors and each
 * sends the other exactly what it is missing, so edits made offline, or before a reload, merge
 * automatically. Acks prune the outbox.
 *
 * Each session uses a fresh replica ID; unacknowledged ops from earlier sessions keep their old
 * IDs and are declared to the server in `hello.owns` so it accepts them from this connection.
 */
export class SyncClient {
  readonly docId: string;
  readonly replica: ReplicaId;
  #doc: Doc;
  readonly #options: SyncClientOptions;
  readonly #storage: ClientStorage;
  /** Unacked local ops of this and earlier sessions, mirrored from storage. */
  #outbox: Op[];
  #acked: VersionVector = {};
  #socket: SocketLike | null = null;
  #status: Status = 'offline';
  /** Server welcome received on the current socket: safe to stream ops. */
  #synced = false;
  #closed = false;
  #retries = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  #presenceTimer: ReturnType<typeof setTimeout> | null = null;
  #cursor: Cursor | null = null;
  #cursorDirty = false;
  readonly #peers = new Map<ReplicaId, Peer>();
  /** Serializes storage writes so they land in order. */
  #persistence: Promise<void> = Promise.resolve();
  /** Replica IDs declared in the current connection's hello: the only ones we may upload. */
  #owns = new Set<ReplicaId>();
  readonly #listeners: { [K in keyof Events]: Set<(arg: Events[K]) => void> } = {
    change: new Set(),
    status: new Set(),
    presence: new Set(),
  };

  private constructor(options: SyncClientOptions, doc: Doc, outbox: Op[]) {
    this.#options = options;
    this.#storage = options.storage;
    this.docId = options.docId;
    this.replica = doc.replica;
    this.#doc = doc;
    this.#outbox = outbox;
  }

  /** Restore local state (snapshot + outbox) and start connecting. */
  static async open(options: SyncClientOptions): Promise<SyncClient> {
    const replica = options.replica ?? randomReplicaId();
    const { snapshot, outbox } = await options.storage.load(options.docId);
    const doc = snapshot ? Doc.fromSnapshot(snapshot, replica) : new Doc(replica);
    doc.applyAll(outbox);
    const client = new SyncClient(options, doc, [...outbox]);
    client.#connect();
    return client;
  }

  get text(): string {
    return this.#doc.toString();
  }

  get length(): number {
    return this.#doc.length;
  }

  get status(): Status {
    return this.#status;
  }

  /** Local ops not yet acknowledged by the server (what would be lost if this device vanished). */
  get unsyncedCount(): number {
    return this.#outbox.length;
  }

  get versionVector(): VersionVector {
    return this.#doc.versionVector();
  }

  insert(index: number, text: string): void {
    if (text.length > 0) this.#local(this.#doc.insert(index, text));
  }

  delete(index: number, count: number): void {
    if (count > 0) this.#local(this.#doc.delete(index, count));
  }

  /** Stable anchor for a visible index (for cursors that survive concurrent edits). */
  anchorAt(index: number): Id {
    return this.#doc.anchorAt(index);
  }

  indexOfAnchor(anchor: Id): number | null {
    return this.#doc.indexOfAnchor(anchor);
  }

  /** Publish this user's selection (visible indices), throttled. */
  setSelection(anchor: number, head: number): void {
    this.#cursor = { anchor: this.#doc.anchorAt(anchor), head: this.#doc.anchorAt(head) };
    this.#cursorDirty = true;
    this.#presenceTimer ??= setTimeout(() => {
      this.#presenceTimer = null;
      this.#flushPresence();
    }, this.#options.presenceThrottleMs ?? 50);
  }

  /** Other users on this document, with selections mapped to current indices. */
  peers(): PeerView[] {
    return [...this.#peers.values()].map((p) => {
      const anchor = p.cursor ? this.#doc.indexOfAnchor(p.cursor.anchor) : null;
      const head = p.cursor ? this.#doc.indexOfAnchor(p.cursor.head) : null;
      return {
        replica: p.replica,
        user: p.user,
        selection: anchor !== null && head !== null ? { anchor, head } : null,
      };
    });
  }

  /** Subscribe to an event; returns an unsubscribe function. */
  on<K extends keyof Events>(event: K, fn: (arg: Events[K]) => void): () => void {
    const set = this.#listeners[event];
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Wait for pending storage writes (tests, and before unload). */
  async flushStorage(): Promise<void> {
    await this.#persistence;
  }

  /** Simulate losing the network (tests/demo): drop the socket and stay offline. */
  goOffline(): void {
    this.#closed = true;
    this.#clearReconnect();
    this.#socket?.close(1000, 'offline');
    this.#socket = null;
    this.#setStatus('offline');
  }

  /** Undo goOffline: reconnect now. */
  goOnline(): void {
    if (!this.#closed) return;
    this.#closed = false;
    this.#retries = 0;
    this.#connect();
  }

  /** Persist a final snapshot and disconnect for good. */
  async close(): Promise<void> {
    this.goOffline();
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    if (this.#presenceTimer) clearTimeout(this.#presenceTimer);
    this.#persist(() => this.#storage.saveSnapshot(this.docId, this.#doc.toSnapshot()));
    await this.#persistence;
  }

  #local(ops: Op[]): void {
    this.#outbox.push(...ops);
    this.#persist(() => this.#storage.appendOutbox(this.docId, ops));
    if (this.#synced) this.#sendOps(ops);
    this.#scheduleSnapshot();
    this.#emit('change', { remote: false, ops });
  }

  #connect(): void {
    if (this.#closed) return;
    this.#setStatus('connecting');
    const connect =
      this.#options.connect ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
    let socket: SocketLike;
    try {
      socket = connect(this.#options.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    this.#synced = false;
    socket.onopen = () => {
      this.#owns = new Set([this.replica, ...this.#outbox.map((op) => op.id.replica)]);
      const owns = [...this.#owns].filter((r) => r !== this.replica);
      socket.send(
        encode({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          doc: this.docId,
          replica: this.replica,
          owns,
          user: this.#options.user,
          vv: this.#doc.versionVector(),
        }),
      );
    };
    socket.onmessage = (ev) => {
      if (this.#socket !== socket || typeof ev.data !== 'string') return;
      let message: ServerMessage;
      try {
        message = parseServerMessage(ev.data);
      } catch {
        socket.close(4400, 'bad server message');
        return;
      }
      this.#receive(message);
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#synced = false;
      this.#peers.clear();
      this.#emit('presence', undefined);
      this.#setStatus('offline');
      this.#scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows and handles reconnection.
    };
  }

  #receive(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome': {
        if (message.snapshot && Object.keys(this.#doc.versionVector()).length === 0) {
          // We had nothing at all: adopt the server's state wholesale (fast first load).
          this.#doc = Doc.fromSnapshot(message.snapshot, this.replica);
          this.#emit('change', { remote: true, ops: [] });
        }
        this.#applyRemote(message.ops);
        for (const peer of message.peers) this.#peers.set(peer.replica, peer);
        this.#emit('presence', undefined);
        this.#synced = true;
        this.#retries = 0;
        this.#setStatus('online');
        // Upload everything the server lacks: our offline edits, plus edits of earlier sessions.
        this.#sendOps(this.#doc.opsSince(message.vv).filter((op) => this.#mayUpload(op)));
        if (this.#cursor) {
          this.#cursorDirty = true;
          this.#flushPresence();
        }
        this.#scheduleSnapshot();
        break;
      }
      case 'ops':
        this.#applyRemote(message.ops);
        break;
      case 'ack':
        this.#onAck(message.vv);
        break;
      case 'presence':
        this.#peers.set(message.peer.replica, message.peer);
        this.#emit('presence', undefined);
        break;
      case 'leave':
        this.#peers.delete(message.replica);
        this.#emit('presence', undefined);
        break;
      case 'error':
        break;
    }
  }

  /** The server only accepts ops of replicas this connection declared (see hello.owns). */
  #mayUpload(op: Op): boolean {
    return this.#owns.has(op.id.replica);
  }

  #applyRemote(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    const integrated = this.#doc.applyAll(ops);
    if (integrated.length === 0) return;
    this.#scheduleSnapshot();
    this.#emit('change', { remote: true, ops: integrated });
  }

  #onAck(vv: VersionVector): void {
    const acked: Record<ReplicaId, number> = { ...this.#acked };
    for (const replica of Object.keys(vv))
      acked[replica] = Math.max(vvGet(this.#acked, replica), vvGet(vv, replica));
    this.#acked = acked;
    const before = this.#outbox.length;
    this.#outbox = this.#outbox.filter((op) => op.seq > vvGet(acked, op.id.replica));
    if (this.#outbox.length !== before) {
      this.#persist(() => this.#storage.pruneOutbox(this.docId, acked));
      this.#emit('status', this.#status);
    }
  }

  #sendOps(ops: readonly Op[]): void {
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) return;
    for (let i = 0; i < ops.length; i += MAX_OPS_PER_FRAME) {
      socket.send(encode({ type: 'ops', ops: ops.slice(i, i + MAX_OPS_PER_FRAME) }));
    }
  }

  #flushPresence(): void {
    if (!this.#cursorDirty || !this.#synced) return;
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) return;
    this.#cursorDirty = false;
    socket.send(encode({ type: 'presence', cursor: this.#cursor }));
  }

  #scheduleSnapshot(): void {
    this.#snapshotTimer ??= setTimeout(() => {
      this.#snapshotTimer = null;
      const snapshot = this.#doc.toSnapshot();
      this.#persist(() => this.#storage.saveSnapshot(this.docId, snapshot));
    }, this.#options.snapshotDebounceMs ?? 1000);
  }

  #persist(write: () => Promise<void>): void {
    this.#persistence = this.#persistence.then(write).catch((error: unknown) => {
      // Storage failures (quota, private mode) must not break editing; the in-memory doc and the
      // server remain the source of truth for this session.
      console.warn('collab: local persistence failed', error);
    });
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer) return;
    const min = this.#options.reconnectMinMs ?? 250;
    const max = this.#options.reconnectMaxMs ?? 10_000;
    // Full jitter: spreads out a thundering herd of clients after a server restart.
    const delay = Math.random() * Math.min(max, min * 2 ** this.#retries);
    this.#retries++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #setStatus(status: Status): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#emit('status', status);
  }

  #emit<K extends keyof Events>(event: K, arg: Events[K]): void {
    for (const fn of this.#listeners[event]) fn(arg);
  }
}

export function randomReplicaId(): ReplicaId {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 20);
}
