import { Doc, type Op, type VersionVector } from '@collab/crdt';
import {
  encode,
  parseServerMessage,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from '@collab/protocol';
import WebSocket from 'ws';
import { messageText } from '../src/server.ts';

/**
 * A raw protocol client for server tests: speaks the wire protocol directly and keeps a Doc so
 * tests can assert on converged text.
 */
export class TestClient {
  readonly doc: Doc;
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];
  closeCode: number | null = null;
  readonly #waiters = new Set<() => void>();

  private constructor(socket: WebSocket, doc: Doc) {
    this.socket = socket;
    this.doc = doc;
    socket.on('message', (data) => {
      const msg = parseServerMessage(messageText(data));
      this.received.push(msg);
      if (msg.type === 'welcome') {
        if (msg.snapshot) this.#replaceDoc(msg.snapshot);
        this.doc.applyAll(msg.ops);
      } else if (msg.type === 'ops') {
        this.doc.applyAll(msg.ops);
      }
      this.#notify();
    });
    socket.on('close', (code) => {
      this.closeCode = code;
      this.#notify();
    });
  }

  static async connect(port: number, options: ConnectOptions = {}): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/sync`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        resolve();
      });
      socket.once('error', reject);
    });
    const client = new TestClient(
      socket,
      options.doc ?? new Doc(options.replica ?? randomReplica()),
    );
    if (options.hello !== false) {
      client.send({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        doc: options.docId ?? 'doc1',
        replica: client.doc.replica,
        owns: options.owns ?? [],
        user: { name: options.name ?? client.doc.replica, color: '#336699' },
        vv: options.vv ?? client.doc.versionVector(),
      });
      await client.waitFor((m) => m.type === 'welcome');
    }
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(encode(message));
  }

  /** Edit locally and send the ops. */
  insert(index: number, text: string, trace?: number): Op[] {
    const ops = this.doc.insert(index, text);
    this.send(trace === undefined ? { type: 'ops', ops } : { type: 'ops', ops, trace });
    return ops;
  }

  delete(index: number, count: number): Op[] {
    const ops = this.doc.delete(index, count);
    this.send({ type: 'ops', ops });
    return ops;
  }

  /** Resolve with the first received message (past or future) matching `predicate`. */
  async waitFor<T extends ServerMessage>(
    predicate: (m: ServerMessage) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
  async waitFor(
    predicate: (m: ServerMessage) => boolean,
    timeoutMs?: number,
  ): Promise<ServerMessage>;
  async waitFor(
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage> {
    return until(
      () => this.received.find(predicate),
      (wake) => this.#waiters.add(wake),
      (wake) => this.#waiters.delete(wake),
      timeoutMs,
      'message',
    );
  }

  /** Resolve once `check` passes (re-evaluated on every received message). */
  async waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
    await until(
      () => (check() ? true : undefined),
      (wake) => this.#waiters.add(wake),
      (wake) => this.#waiters.delete(wake),
      timeoutMs,
      'condition',
    );
  }

  async waitForClose(timeoutMs = 5000): Promise<number> {
    await this.waitUntil(() => this.closeCode !== null, timeoutMs);
    return this.closeCode ?? 0;
  }

  /** Acknowledged seq for this client's replica, per the latest ack. */
  ackedSeq(): number {
    const acks = this.received.filter((m) => m.type === 'ack');
    const last = acks.at(-1);
    return last ? (last.vv[this.doc.replica] ?? 0) : 0;
  }

  async close(): Promise<void> {
    if (this.closeCode !== null) return;
    this.socket.close();
    await this.waitForClose();
  }

  #replaceDoc(
    snapshot: NonNullable<Extract<ServerMessage, { type: 'welcome' }>['snapshot']>,
  ): void {
    const restored = Doc.fromSnapshot(snapshot, this.doc.replica);
    // Tests only take snapshots into empty docs; copy state by replaying the history.
    this.doc.applyAll(restored.opsSince({}));
  }

  #notify(): void {
    for (const wake of this.#waiters) wake();
  }
}

export interface ConnectOptions {
  readonly docId?: string;
  readonly replica?: string;
  readonly doc?: Doc;
  readonly owns?: string[];
  readonly name?: string;
  readonly vv?: VersionVector;
  /** Set false to connect without sending hello. */
  readonly hello?: boolean;
}

let counter = 0;
export function randomReplica(): string {
  counter++;
  return `t${String(counter)}x${Math.random().toString(36).slice(2, 8)}`;
}

async function until<T>(
  probe: () => T | undefined,
  subscribe: (wake: () => void) => void,
  unsubscribe: (wake: () => void) => void,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const now = probe();
  if (now !== undefined) return now;
  return new Promise<T>((resolve, reject) => {
    const wake = () => {
      const value = probe();
      if (value === undefined) return;
      clearTimeout(timer);
      unsubscribe(wake);
      resolve(value);
    };
    const timer = setTimeout(() => {
      unsubscribe(wake);
      reject(new Error(`timed out waiting for ${what}`));
    }, timeoutMs);
    subscribe(wake);
  });
}

/** Poll an async condition (for state not driven by a client's messages). */
export async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
