import 'fake-indexeddb/auto';
import {
  MemoryStore,
  PostgresStore,
  startServer,
  type DocStore,
  type SyncServer,
} from '@collab/server';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbStorage, SyncClient, type ClientStorage } from '../src/index.ts';

/**
 * End-to-end offline editing: real sync server, real WebSockets, IndexedDB persistence (an
 * in-memory implementation, one database per simulated browser). Uses Postgres when
 * DATABASE_URL is set, so the server restart is a real restart from durable storage.
 */

const servers: SyncServer[] = [];
const clients: SyncClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function makeStore(): Promise<DocStore> {
  const url = process.env.DATABASE_URL;
  if (!url) return new MemoryStore();
  const pg = new PostgresStore(url);
  await pg.migrate();
  return pg;
}

async function serve(store: DocStore, port = 0): Promise<SyncServer> {
  const server = await startServer({ store, port, host: '127.0.0.1', snapshotEvery: 20 });
  servers.push(server);
  return server;
}

async function open(port: number, docId: string, storage: ClientStorage, name: string) {
  const client = await SyncClient.open({
    url: `ws://127.0.0.1:${String(port)}/sync`,
    docId,
    user: { name, color: '#3366cc' },
    storage,
    reconnectMinMs: 20,
    reconnectMaxMs: 200,
    snapshotDebounceMs: 10,
  });
  clients.push(client);
  return client;
}

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const browser = () => new IndexedDbStorage('collab-test', new IDBFactory());
const docId = () => `offline-${Math.random().toString(36).slice(2)}`;

describe('offline editing, end to end', () => {
  it('two clients edit while offline, one reloads the page offline, and both converge', async () => {
    const store = await makeStore();
    const server = await serve(store);
    const port = server.port;
    const id = docId();
    const aliceDisk = browser();
    const bobDisk = browser();

    const alice = await open(port, id, aliceDisk, 'Alice');
    let bob = await open(port, id, bobDisk, 'Bob');
    await until(() => alice.status === 'online' && bob.status === 'online');
    alice.insert(0, 'The quick fox');
    await until(() => bob.text === 'The quick fox' && alice.unsyncedCount === 0);

    // The network goes away: the server is stopped. Both clients notice and keep editing.
    await server.close();
    servers.length = 0;
    await until(() => alice.status !== 'online' && bob.status !== 'online');

    alice.insert(alice.length, ' jumps'); // "The quick fox jumps"
    alice.delete(4, 6); // "The fox jumps"
    bob.insert(10, 'brown '); // "The quick brown fox" (origin: the space Alice deletes)
    bob.insert(0, '>> ');
    expect(alice.unsyncedCount).toBeGreaterThan(0);
    expect(bob.unsyncedCount).toBeGreaterThan(0);

    // Bob reloads the tab while still offline: everything must come back from IndexedDB.
    const bobBefore = bob.text;
    await bob.close();
    clients.splice(clients.indexOf(bob), 1);
    bob = await open(port, id, bobDisk, 'Bob');
    expect(bob.text).toBe(bobBefore);
    bob.insert(0, '#'); // edits under the new session's replica ID

    // The server comes back on the same port, from durable storage.
    await serve(store, port);
    await until(() => alice.status === 'online' && bob.status === 'online');
    await until(
      () => alice.text === bob.text && alice.unsyncedCount === 0 && bob.unsyncedCount === 0,
    );

    // Both users' edits survive: Alice's delete of "quick " and " jumps"; Bob's "brown ", ">> "
    // and, from his reloaded session, "#". "brown " survives even though its origin was deleted.
    expect(alice.text).toBe('#>> The brown fox jumps');

    // A third client, opened fresh after the merge, sees the same document.
    const carol = await open(port, id, browser(), 'Carol');
    await until(() => carol.status === 'online');
    expect(carol.text).toBe(alice.text);

    // Acks pruned the outboxes on disk too.
    await alice.flushStorage();
    await bob.flushStorage();
    expect((await aliceDisk.load(id)).outbox).toHaveLength(0);
    expect((await bobDisk.load(id)).outbox).toHaveLength(0);
  }, 30_000);

  it('opens a document offline from local storage before the server ever saw the edits', async () => {
    const store = await makeStore();
    const disk = browser();
    const id = docId();
    // A port nothing listens on: the client starts offline.
    const offline = await open(1, id, disk, 'Solo');
    offline.insert(0, 'drafted on a plane');
    await offline.close();
    clients.splice(clients.indexOf(offline), 1);

    const server = await serve(store);
    const later = await open(server.port, id, disk, 'Solo');
    expect(later.text).toBe('drafted on a plane');
    await until(() => later.status === 'online' && later.unsyncedCount === 0);
    const viewer = await open(server.port, id, browser(), 'Viewer');
    await until(() => viewer.text === 'drafted on a plane');
  }, 30_000);

  it('shows remote cursors that track concurrent edits', async () => {
    const server = await serve(await makeStore());
    const id = docId();
    const alice = await open(server.port, id, browser(), 'Alice');
    const bob = await open(server.port, id, browser(), 'Bob');
    await until(() => alice.status === 'online' && bob.status === 'online');
    alice.insert(0, 'hello world');
    await until(() => bob.text === 'hello world');
    alice.setSelection(6, 11); // "world"
    await until(() => bob.peers().some((p) => p.selection?.anchor === 6));
    bob.insert(0, '>> ');
    await until(() => alice.text === '>> hello world');
    // Bob's view of Alice's selection shifted with the text.
    expect(bob.peers().find((p) => p.user.name === 'Alice')?.selection).toEqual({
      anchor: 9,
      head: 14,
    });
    await alice.close();
    clients.splice(clients.indexOf(alice), 1);
    await until(() => bob.peers().length === 0);
  }, 30_000);
});
