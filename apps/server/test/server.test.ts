import { Doc } from '@collab/crdt';
import { CloseCode, PROTOCOL_VERSION } from '@collab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type ServerOptions, type SyncServer } from '../src/server.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { eventually, TestClient } from './helpers.ts';

let server: SyncServer | null = null;
const clients: TestClient[] = [];

async function start(options: Partial<ServerOptions> = {}) {
  const store = options.store instanceof MemoryStore ? options.store : new MemoryStore();
  server = await startServer({ store, port: 0, ...options });
  return { server, store };
}

async function connect(
  ...args: Parameters<typeof TestClient.connect> extends [number, ...infer R] ? R : never
) {
  if (!server) throw new Error('server not started');
  const client = await TestClient.connect(server.port, ...args);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
  await server?.close();
  server = null;
});

describe('sync server', () => {
  it('relays ops between clients in a room and acks the sender once persisted', async () => {
    const { store } = await start();
    const alice = await connect({ replica: 'alice' });
    const bob = await connect({ replica: 'bob' });
    alice.insert(0, 'hello');
    await bob.waitUntil(() => bob.doc.toString() === 'hello');
    await alice.waitUntil(() => alice.ackedSeq() === 5);
    expect(store.opCount('doc1')).toBe(5);
    bob.insert(5, ' world');
    await alice.waitUntil(() => alice.doc.toString() === 'hello world');
    // Senders don't get their own ops echoed back.
    expect(alice.received.flatMap((m) => (m.type === 'ops' ? m.ops : []))).toHaveLength(6);
  });

  it('isolates documents in separate rooms', async () => {
    await start();
    const a = await connect({ docId: 'one' });
    const b = await connect({ docId: 'two' });
    a.insert(0, 'only in one');
    await a.waitUntil(() => a.ackedSeq() === 11);
    expect(b.doc.toString()).toBe('');
  });

  it('sends a fresh client the whole document as a snapshot', async () => {
    await start();
    const alice = await connect();
    alice.insert(0, 'snapshot me');
    await alice.waitUntil(() => alice.ackedSeq() === 11);
    const late = await connect();
    const welcome = late.received.find((m) => m.type === 'welcome');
    expect(welcome?.type === 'welcome' && welcome.snapshot).toBeTruthy();
    expect(late.doc.toString()).toBe('snapshot me');
  });

  it('on reconnect sends exactly the ops missing from the client version vector', async () => {
    await start();
    const alice = await connect({ replica: 'alice' });
    let bob = await connect({ replica: 'bob' });
    alice.insert(0, 'abc');
    await bob.waitUntil(() => bob.doc.toString() === 'abc');
    const bobDoc = bob.doc;
    await bob.close();
    alice.insert(3, 'def');
    alice.delete(0, 1);
    await alice.waitUntil(() => alice.ackedSeq() === 7);

    bob = await connect({ doc: bobDoc });
    const welcome = bob.received.find((m) => m.type === 'welcome');
    if (welcome?.type !== 'welcome') throw new Error('no welcome');
    expect(welcome.snapshot).toBeNull();
    expect(welcome.ops).toHaveLength(4);
    expect(bob.doc.toString()).toBe('bcdef');
  });

  it('accepts a reconnecting client’s offline ops and acks duplicates without rebroadcasting them', async () => {
    const { store } = await start();
    const bob = await connect({ replica: 'bob' });
    const offline = new Doc('alice');
    const ops = offline.insert(0, 'written offline');
    const alice = await connect({ doc: offline });
    alice.send({ type: 'ops', ops });
    await bob.waitUntil(() => bob.doc.toString() === 'written offline');
    await alice.waitUntil(() => alice.ackedSeq() === ops.length);
    const before = bob.received.length;
    alice.send({ type: 'ops', ops }); // e.g. resent from an outbox after a lost ack
    await alice.waitUntil(() => alice.received.filter((m) => m.type === 'ack').length >= 2);
    expect(bob.received.slice(before).some((m) => m.type === 'ops')).toBe(false);
    expect(store.opCount('doc1')).toBe(ops.length);
  });

  it('lets a client upload ops of replica IDs it declared in owns, and nothing else', async () => {
    await start();
    const previous = new Doc('old-session');
    const ops = previous.insert(0, 'x');
    const ok = await connect({ owns: ['old-session'] });
    ok.send({ type: 'ops', ops });
    await ok.waitUntil(() => ok.received.findLast((m) => m.type === 'ack')?.type === 'ack');
    const thief = await connect();
    thief.send({ type: 'ops', ops: new Doc('victim').insert(0, 'y') });
    expect(await thief.waitForClose()).toBe(CloseCode.BadMessage);
    expect(thief.received.some((m) => m.type === 'error' && m.code === 'forbidden')).toBe(true);
  });

  it('closes connections that send malformed frames or skip hello', async () => {
    await start({ helloTimeoutMs: 100 });
    const garbage = await connect();
    garbage.socket.send('{not json');
    expect(await garbage.waitForClose()).toBe(CloseCode.BadMessage);
    const silent = await connect({ hello: false });
    expect(await silent.waitForClose()).toBe(CloseCode.BadMessage);
    const early = await connect({ hello: false });
    early.send({ type: 'presence', cursor: null });
    expect(await early.waitForClose()).toBe(CloseCode.BadMessage);
  });

  it('replaces an older connection that uses the same replica ID', async () => {
    await start();
    const first = await connect({ replica: 'same' });
    await connect({ replica: 'same' });
    expect(await first.waitForClose()).toBe(CloseCode.Replaced);
  });

  it('shares presence: peers in welcome, cursor updates, and leave', async () => {
    await start();
    const alice = await connect({ replica: 'alice', name: 'Alice' });
    alice.insert(0, 'hello');
    const bob = await connect({ replica: 'bob', name: 'Bob' });
    const welcome = bob.received.find((m) => m.type === 'welcome');
    expect(welcome?.type === 'welcome' && welcome.peers.map((p) => p.user.name)).toEqual(['Alice']);
    await alice.waitFor((m) => m.type === 'presence' && m.peer.replica === 'bob');

    const cursor = { anchor: alice.doc.anchorAt(3), head: alice.doc.anchorAt(3) };
    alice.send({ type: 'presence', cursor });
    const update = await bob.waitFor(
      (m) => m.type === 'presence' && m.peer.replica === 'alice' && m.peer.cursor !== null,
    );
    expect(update.type === 'presence' && update.peer.cursor).toEqual(cursor);
    await alice.close();
    await bob.waitFor((m) => m.type === 'leave' && m.replica === 'alice');
  });

  it('retries failed appends and only acks once the write succeeds', async () => {
    const store = new MemoryStore();
    store.failNextAppends = 2;
    await start({ store });
    const alice = await connect();
    alice.insert(0, 'retry');
    await alice.waitUntil(() => alice.ackedSeq() === 5);
    expect(store.opCount('doc1')).toBe(5);
    expect(server?.metrics.counter('sync_persist_errors_total')).toBe(2);
  });

  it('enforces the per-connection op rate limit', async () => {
    await start({ rateLimit: { burst: 10, perSecond: 1 } });
    const flood = await connect();
    flood.insert(0, 'x'.repeat(11));
    expect(await flood.waitForClose()).toBe(CloseCode.BadMessage);
    expect(server?.metrics.counter('sync_rate_limited_total')).toBe(1);
  });

  it('snapshots, unloads idle rooms and reloads them from storage', async () => {
    const { store } = await start({ snapshotEvery: 10, roomIdleMs: 50 });
    const alice = await connect();
    alice.insert(0, 'a'.repeat(25));
    alice.delete(0, 5);
    await alice.waitUntil(() => alice.ackedSeq() === 30);
    await eventually(() => (server?.metrics.counter('sync_snapshots_total') ?? 0) >= 1);
    await alice.close();
    await eventually(() => server?.room('doc1') === undefined);
    const loaded = await store.load('doc1');
    expect(loaded.snapshot).not.toBeNull();
    expect(loaded.ops).toHaveLength(0); // closing the room snapshotted the tail too

    const bob = await connect();
    expect(bob.doc.toString()).toBe('a'.repeat(20));
  });

  it('rejects a hello for an unsupported protocol version', async () => {
    await start();
    const client = await connect({ hello: false });
    client.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION + 1,
      doc: 'doc1',
      replica: 'abc',
      owns: [],
      user: { name: 'x', color: '#000000' },
      vv: {},
    });
    expect(await client.waitForClose()).toBe(CloseCode.BadMessage);
  });
});
