import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fanout, FanoutHandler, FanoutMessage } from '../src/fanout.ts';
import { RedisFanout } from '../src/redis-fanout.ts';
import { silentLogger } from '../src/log.ts';
import { startServer, type SyncServer } from '../src/server.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { PostgresStore } from '../src/store/postgres.ts';
import type { DocStore } from '../src/store/store.ts';
import { TestClient } from './helpers.ts';

/** In-process pub/sub shared by several "instances", with a configurable message loss rate. */
class Bus {
  readonly #subs = new Map<string, Set<{ instance: number; handler: FanoutHandler }>>();
  dropRate = 0;
  delivered = 0;

  fanout(instance: number): Fanout {
    return {
      subscribe: async (docId, handler) => {
        await Promise.resolve();
        const set = this.#subs.get(docId) ?? new Set();
        const entry = { instance, handler };
        set.add(entry);
        this.#subs.set(docId, set);
        return async () => {
          await Promise.resolve();
          set.delete(entry);
        };
      },
      publish: (docId, message: FanoutMessage) => {
        for (const sub of this.#subs.get(docId) ?? []) {
          if (sub.instance === instance || Math.random() < this.dropRate) continue;
          this.delivered++;
          const copy = JSON.parse(JSON.stringify(message)) as FanoutMessage;
          setTimeout(() => {
            sub.handler(copy);
          }, 1);
        }
      },
      close: async () => {
        await Promise.resolve();
      },
    };
  }
}

const servers: SyncServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.socket.terminate();
  for (const s of servers.splice(0)) await s.close();
});

async function pair(store: DocStore, fanouts: [Fanout, Fanout], catchUpMs: number | null) {
  for (const fanout of fanouts) {
    servers.push(await startServer({ store, fanout, catchUpMs, port: 0, host: '127.0.0.1' }));
  }
  return servers as [SyncServer, SyncServer];
}

describe('scale-out: several server instances, one document', () => {
  it('relays ops between instances through the fanout', async () => {
    const bus = new Bus();
    const [s1, s2] = await pair(new MemoryStore(), [bus.fanout(1), bus.fanout(2)], null);
    const alice = await TestClient.connect(s1.port, { replica: 'alice' });
    const bob = await TestClient.connect(s2.port, { replica: 'bob' });
    clients.push(alice, bob);
    alice.insert(0, 'via instance 1');
    bob.insert(0, 'via instance 2: ');
    await alice.waitUntil(
      () => alice.doc.toString() === bob.doc.toString() && alice.doc.length === 30,
    );
    await bob.waitUntil(() => bob.doc.length === 30);
    // Presence crosses instances too.
    await bob.waitFor((m) => m.type === 'presence' && m.peer.replica === 'alice');
  });

  it('still converges when the fanout loses every message, via the storage catch-up poll', async () => {
    const bus = new Bus();
    bus.dropRate = 1;
    const [s1, s2] = await pair(new MemoryStore(), [bus.fanout(1), bus.fanout(2)], 50);
    const alice = await TestClient.connect(s1.port, { replica: 'alice' });
    const bob = await TestClient.connect(s2.port, { replica: 'bob' });
    clients.push(alice, bob);
    alice.insert(0, 'hello from 1');
    bob.insert(0, 'and from 2. ');
    await bob.waitUntil(() => bob.doc.length === 24);
    await alice.waitUntil(() => alice.doc.toString() === bob.doc.toString());
    expect(bus.delivered).toBe(0);
    expect(s1.metrics.counter('sync_catchup_ops_total')).toBeGreaterThan(0);
    expect(s2.metrics.counter('sync_catchup_ops_total')).toBeGreaterThan(0);
  });

  const pg = process.env.DATABASE_URL;
  const redis = process.env.REDIS_URL;
  it.skipIf(!pg || !redis)('works with real Postgres and Redis', async () => {
    const store = new PostgresStore(pg ?? '');
    await store.migrate();
    const fanouts = await Promise.all([
      RedisFanout.connect(redis ?? '', silentLogger),
      RedisFanout.connect(redis ?? '', silentLogger),
    ]);
    // Polling disabled: propagation must come from Redis alone.
    const [s1, s2] = await pair(store, fanouts, null);
    const docId = `scale-${randomUUID()}`;
    const alice = await TestClient.connect(s1.port, { docId, replica: 'alice' });
    const bob = await TestClient.connect(s2.port, { docId, replica: 'bob' });
    clients.push(alice, bob);
    alice.insert(0, 'redis ');
    bob.insert(0, 'pubsub ');
    await alice.waitUntil(() => alice.doc.length === 13);
    await bob.waitUntil(() => bob.doc.toString() === alice.doc.toString());
    for (const s of servers.splice(0)) await s.close();
    await Promise.all(fanouts.map((f) => f.close()));
    await store.close();
  });
});
