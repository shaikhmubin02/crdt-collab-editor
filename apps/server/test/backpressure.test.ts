import type { Socket } from 'node:net';
import type { Doc } from '@collab/crdt';
import { MAX_OPS_PER_FRAME } from '@collab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type SyncServer } from '../src/server.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { eventually, TestClient } from './helpers.ts';

let server: SyncServer | null = null;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.socket.terminate();
  await server?.close();
  server = null;
});

/** The ws client's underlying TCP socket (not part of its public API). */
const tcp = (client: TestClient) => (client.socket as unknown as { _socket: Socket })._socket;

describe('backpressure', () => {
  it('disconnects a client that stops reading, without slowing anyone else, and it resyncs on reconnect', async () => {
    server = await startServer({
      store: new MemoryStore(),
      port: 0,
      backpressure: { highWaterBytes: 64 * 1024, maxQueuedOps: 1_000_000, maxStallMs: 1000 },
      rateLimit: { burst: 1_000_000, perSecond: 1_000_000 },
    });
    const writer = await TestClient.connect(server.port, { replica: 'writer' });
    const reader = await TestClient.connect(server.port, { replica: 'reader' });
    const slow = await TestClient.connect(server.port, { replica: 'slow' });
    clients.push(writer, reader, slow);

    tcp(slow).pause(); // stops reading: kernel buffers fill, then the server's queue grows

    // Enough data (~15 MB of frames) to overflow the OS socket buffers on any platform.
    const total = 30 * MAX_OPS_PER_FRAME;
    for (let i = 0; i < total; i += MAX_OPS_PER_FRAME) {
      writer.insert(writer.doc.length, 'x'.repeat(MAX_OPS_PER_FRAME));
    }

    // A client that reads normally gets everything, however large the burst...
    await reader.waitUntil(() => reader.doc.length === total, 20_000);
    await writer.waitUntil(() => writer.ackedSeq() === total, 20_000);
    // ...while the one that stopped reading is cut loose, and only that one.
    await eventually(
      () => server?.metrics.counter('sync_slow_consumer_disconnects_total') === 1,
      10_000,
    );
    const room = await server.room('doc1');
    expect([...(room?.clients ?? [])].map((c) => c.replica).sort()).toEqual(['reader', 'writer']);
    expect(reader.closeCode).toBeNull();

    // The slow client comes back with whatever it managed to receive and catches up exactly.
    const partial: Doc = slow.doc;
    slow.socket.terminate();
    const back = await TestClient.connect(server.port, { doc: partial });
    clients.push(back);
    await back.waitUntil(() => back.doc.length === total, 20_000);
    expect(back.doc.toString()).toBe(writer.doc.toString());
  }, 60_000);
});
