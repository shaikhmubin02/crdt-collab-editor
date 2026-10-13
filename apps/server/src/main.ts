import { jsonLogger, type Level } from './log.ts';
import { startServer } from './server.ts';
import { MemoryStore } from './store/memory.ts';
import { PostgresStore } from './store/postgres.ts';
import type { DocStore } from './store/store.ts';
import type { Fanout } from './fanout.ts';

const env = process.env;
const log = jsonLogger((env.LOG_LEVEL as Level | undefined) ?? 'info');

function int(name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

let store: DocStore;
if (env.DATABASE_URL) {
  const pg = new PostgresStore(env.DATABASE_URL, int('PG_POOL_SIZE', 10));
  await pg.migrate();
  store = pg;
} else {
  log.log('warn', 'DATABASE_URL not set: using in-memory storage, documents are lost on restart');
  store = new MemoryStore();
}

let fanout: Fanout | null = null;
if (env.REDIS_URL) {
  const { RedisFanout } = await import('./redis-fanout.ts');
  fanout = await RedisFanout.connect(env.REDIS_URL, log);
}

const server = await startServer({
  store,
  fanout,
  log,
  port: int('PORT', 8787),
  host: env.HOST ?? '0.0.0.0',
  snapshotEvery: int('SNAPSHOT_EVERY', 1000),
  roomIdleMs: int('ROOM_IDLE_MS', 30_000),
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.log('info', 'shutting down', { signal });
    void (async () => {
      await server.close();
      await fanout?.close();
      await store.close();
      process.exit(0);
    })();
  });
}
