import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type SyncServer } from '../src/server.ts';
import { PostgresStore } from '../src/store/postgres.ts';
import { TestClient } from './helpers.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('server restart with Postgres', () => {
  const servers: SyncServer[] = [];
  const clients: TestClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.terminate();
    for (const s of servers.splice(0)) await s.close();
  });

  it('serves the same document after the process restarts (snapshot + tail replay)', async () => {
    const docId = `restart-${randomUUID()}`;
    const run = async () => {
      const store = new PostgresStore(url ?? '');
      await store.migrate();
      const server = await startServer({ store, port: 0, snapshotEvery: 50 });
      servers.push(server);
      return { server, store };
    };

    const first = await run();
    const alice = await TestClient.connect(first.server.port, { docId });
    clients.push(alice);
    alice.insert(0, 'x'.repeat(120)); // crosses the snapshot threshold twice
    alice.delete(10, 30);
    alice.insert(0, 'tail after the last snapshot');
    const total = 120 + 30 + 28;
    await alice.waitUntil(() => alice.ackedSeq() === total);
    const expected = alice.doc.toString();
    alice.socket.terminate();
    await first.server.close();
    await first.store.close();
    servers.length = 0;

    const second = await run();
    const loaded = await second.store.load(docId);
    expect(loaded.snapshot).not.toBeNull();
    const bob = await TestClient.connect(second.server.port, { docId });
    clients.push(bob);
    expect(bob.doc.toString()).toBe(expected);
    await second.store.close().catch(() => undefined);
  });
});
