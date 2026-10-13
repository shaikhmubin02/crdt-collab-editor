/**
 * Document load time from Postgres: full op-log replay vs. latest snapshot + tail.
 *
 *   docker compose up -d postgres && bench/fetch-traces.sh
 *   DATABASE_URL=postgres://collab:collab@127.0.0.1:55432/collab node bench/load.bench.ts
 *
 * "Load" is what a server does when the first client opens a document: read from Postgres and
 * materialize the Doc. Writes results to bench/results/load.json.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Doc, type Op } from '../packages/crdt/src/index.ts';
import { PostgresStore } from '../apps/server/src/store/postgres.ts';
import { materialize } from '../apps/server/src/store/snapshot-builder.ts';
import { loadTrace, machine, time } from './lib.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('set DATABASE_URL');
const RUNS = 5;
const APPEND_BATCH = 500;

const store = new PostgresStore(url);
await store.migrate();

const trace = loadTrace('automerge-paper');
const author = new Doc('author');
const ops: Op[] = [];
for (const [pos, del, ins] of trace.patches) {
  if (del > 0) ops.push(...author.delete(pos, del));
  if (ins.length > 0) ops.push(...author.insert(pos, ins));
}

async function appendAll(docId: string, list: readonly Op[]): Promise<number> {
  const { ms } = await timeAsync(async () => {
    for (let i = 0; i < list.length; i += APPEND_BATCH) {
      await store.append(docId, list.slice(i, i + APPEND_BATCH));
    }
  });
  return ms;
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

async function measureLoad(docId: string) {
  const samples: { readMs: number; materializeMs: number; totalMs: number; tail: number }[] = [];
  for (let r = 0; r < RUNS + 1; r++) {
    const read = await timeAsync(() => store.load(docId));
    const built = time(() => materialize(read.value.snapshot, read.value.ops, '_bench'));
    if (built.value.toString() !== trace.endContent) throw new Error(`${docId}: wrong text`);
    if (r > 0) {
      samples.push({
        readMs: read.ms,
        materializeMs: built.ms,
        totalMs: read.ms + built.ms,
        tail: read.value.ops.length,
      });
    }
  }
  samples.sort((a, b) => a.totalMs - b.totalMs);
  const median = samples[Math.floor(samples.length / 2)];
  if (!median) throw new Error('no samples');
  return {
    ...round(median),
    minTotalMs: Math.round(samples[0]?.totalMs ?? 0),
    maxTotalMs: Math.round(samples.at(-1)?.totalMs ?? 0),
  };
}

const results: Record<string, unknown> = {};
const report = (name: string, data: Record<string, unknown>) => {
  results[name] = data;
  console.log(name.padEnd(40), JSON.stringify(data));
};

// 1. No snapshot: every load replays the whole log.
const plain = `bench-plain-${randomUUID()}`;
const appendMs = await appendAll(plain, ops);
report('append (batches of 500)', {
  ops: ops.length,
  ms: Math.round(appendMs),
  opsPerSec: Math.round(ops.length / (appendMs / 1000)),
});
report('load: full log replay', { ops: ops.length, ...(await measureLoad(plain)) });

// 2. Snapshot of everything but the last N ops, then N ops of tail. With SNAPSHOT_EVERY=1000 the
//    tail is at most 1000 ops, so 1000 is the worst case and 0 the best.
for (const tail of [0, 1000]) {
  const docId = `bench-snap-${String(tail)}-${randomUUID()}`;
  await appendAll(docId, ops.slice(0, ops.length - tail));
  const compact = await timeAsync(() => store.compact(docId));
  await appendAll(docId, ops.slice(ops.length - tail));
  const stored = await store.load(docId);
  report(`load: snapshot + ${String(tail)}-op tail`, {
    ...(await measureLoad(docId)),
    snapshotJsonBytes: JSON.stringify(stored.snapshot).length,
    firstSnapshotMs: Math.round(compact.ms),
  });
  if (tail > 0) {
    // What the server pays every SNAPSHOT_EVERY ops: previous snapshot + the tail -> new snapshot.
    const incremental = await timeAsync(() => store.compact(docId));
    report('compaction: incremental (1000 new ops)', {
      ms: Math.round(incremental.ms),
      replayed: incremental.value?.replayed ?? 0,
    });
  }
}

await store.close();
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('./results/load.json', import.meta.url),
  `${JSON.stringify({ date: new Date().toISOString(), machine: machine(), trace: 'automerge-paper', results }, null, 2)}\n`,
);

function round<T extends Record<string, number>>(o: T): T {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10])) as T;
}
