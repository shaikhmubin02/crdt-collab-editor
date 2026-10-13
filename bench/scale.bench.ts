/**
 * Scale-out load test driver: for each editor count, start two fresh server instances (Postgres +
 * Redis), run the k6 propagation test against both, then scrape each instance's server-side
 * latency histogram and CPU time.
 *
 *   docker compose up -d postgres redis
 *   node bench/scale.bench.ts [10 50 100 200]
 *
 * Writes bench/results/scale.json. Requires Docker (k6 runs as grafana/k6:2.3.0).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { machine } from './lib.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORTS = [8787, 8788];
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://collab:collab@127.0.0.1:55432/collab';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:56379';
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const CPS = Number(process.env.CPS ?? 5);
const counts = process.argv.slice(2).map(Number);
if (counts.length === 0) counts.push(10, 50, 100, 200);

interface Histogram {
  readonly buckets: readonly (readonly [number, number])[];
  readonly count: number;
}

function parseHistogram(metrics: string, name: string): Histogram {
  const buckets: [number, number][] = [];
  let count = 0;
  for (const line of metrics.split('\n')) {
    const bucket = new RegExp(`^${name}_bucket\\{le="([^"]+)"\\} (\\d+)`).exec(line);
    if (bucket?.[1] && bucket[2] && bucket[1] !== '+Inf')
      buckets.push([Number(bucket[1]), Number(bucket[2])]);
    const c = new RegExp(`^${name}_count (\\d+)`).exec(line);
    if (c?.[1]) count = Number(c[1]);
  }
  return { buckets, count };
}

function mergeHistograms(hs: readonly Histogram[]): Histogram {
  const first = hs[0];
  if (!first) return { buckets: [], count: 0 };
  return {
    buckets: first.buckets.map(([le], i) => [
      le,
      hs.reduce((s, h) => s + (h.buckets[i]?.[1] ?? 0), 0),
    ]),
    count: hs.reduce((s, h) => s + h.count, 0),
  };
}

/** Quantile by linear interpolation inside the bucket that contains it. */
function quantile(h: Histogram, q: number): number | null {
  if (h.count === 0) return null;
  const target = q * h.count;
  let prevLe = 0;
  let prevCount = 0;
  for (const [le, cumulative] of h.buckets) {
    if (cumulative >= target) {
      const inBucket = cumulative - prevCount;
      const frac = inBucket === 0 ? 0 : (target - prevCount) / inBucket;
      return Math.round((prevLe + frac * (le - prevLe)) * 10) / 10;
    }
    prevLe = le;
    prevCount = cumulative;
  }
  return null; // beyond the last finite bucket
}

async function startInstances(): Promise<ChildProcess[]> {
  const procs = PORTS.map((port) =>
    spawn(process.execPath, ['apps/server/src/main.ts'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), DATABASE_URL, REDIS_URL, LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'ignore', 'inherit'],
    }),
  );
  for (const port of PORTS) {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).ok) break;
      } catch {
        if (i > 100) throw new Error(`instance on ${String(port)} did not start`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return procs;
}

/** CPU seconds used so far by a process (Windows via PowerShell, else /proc). */
function cpuSeconds(pid: number): number {
  if (process.platform === 'win32') {
    const out = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Process -Id ${String(pid)}).CPU`],
      {
        encoding: 'utf8',
      },
    );
    return Number(out.stdout.trim());
  }
  const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8').split(' ');
  return (Number(stat[13]) + Number(stat[14])) / 100;
}

const results: unknown[] = [];
for (const editors of counts) {
  const procs = await startInstances();
  const cpuBefore = procs.map((p) => cpuSeconds(p.pid ?? 0));
  const started = Date.now();
  const k6 = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${ROOT.replace(/\\/g, '/')}bench/k6:/scripts`,
      '-e',
      `EDITORS=${String(editors)}`,
      '-e',
      `DURATION_S=${String(DURATION_S)}`,
      '-e',
      `CPS=${String(CPS)}`,
      '-e',
      `OUT=/scripts/results/k6-${String(editors)}.json`,
      '-e',
      `SYNC_URLS=${PORTS.map((p) => `ws://host.docker.internal:${String(p)}/sync`).join(',')}`,
      'grafana/k6:2.3.0',
      'run',
      '--quiet',
      '/scripts/propagation.js',
    ],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  const wallS = (Date.now() - started) / 1000;
  if (k6.status !== 0) throw new Error(`k6 failed: ${k6.stderr}`);
  const client = JSON.parse(k6.stdout.slice(k6.stdout.indexOf('{'))) as Record<string, unknown>;
  const metrics = await Promise.all(
    PORTS.map(async (p) => (await fetch(`http://127.0.0.1:${String(p)}/metrics`)).text()),
  );
  const server = mergeHistograms(metrics.map((m) => parseHistogram(m, 'sync_server_latency_ms')));
  const persist = mergeHistograms(metrics.map((m) => parseHistogram(m, 'sync_persist_ms')));
  const slow = metrics.reduce(
    (s, m) => s + Number(/sync_slow_consumer_disconnects_total (\d+)/.exec(m)?.[1] ?? 0),
    0,
  );
  const serverCpuPct = procs.map((p, i) =>
    Math.round(((cpuSeconds(p.pid ?? 0) - (cpuBefore[i] ?? 0)) / wallS) * 100),
  );
  for (const p of procs) p.kill();
  const row = {
    ...client,
    serverLatencyMs: {
      p50: quantile(server, 0.5),
      p99: quantile(server, 0.99),
      samples: server.count,
    },
    persistMs: {
      p50: quantile(persist, 0.5),
      p99: quantile(persist, 0.99),
      batches: persist.count,
    },
    serverCpuPercent: serverCpuPct,
    slowConsumerDisconnects: slow,
  };
  console.log(JSON.stringify(row));
  results.push(row);
  await new Promise((r) => setTimeout(r, 2000));
}

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('./results/scale.json', import.meta.url),
  `${JSON.stringify({ date: new Date().toISOString(), machine: machine(), durationS: DURATION_S, cps: CPS, results }, null, 2)}\n`,
);
