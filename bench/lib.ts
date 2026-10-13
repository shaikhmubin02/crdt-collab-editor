import { readFileSync } from 'node:fs';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';

export interface Trace {
  readonly name: string;
  readonly endContent: string;
  /** [position, numDeleted, insertedText], splice semantics. */
  readonly patches: readonly (readonly [number, number, string])[];
}

interface RawTrace {
  endContent: string;
  txns: { patches: [number, number, string][] }[];
}

export function loadTrace(name: string): Trace {
  const url = new URL(`./traces/${name}.json.gz`, import.meta.url);
  let raw: RawTrace;
  try {
    raw = JSON.parse(gunzipSync(readFileSync(url)).toString('utf8')) as RawTrace;
  } catch (cause) {
    throw new Error(`trace ${name} missing: run bench/fetch-traces.sh first`, { cause });
  }
  return { name, endContent: raw.endContent, patches: raw.txns.flatMap((t) => t.patches) };
}

export function machine() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model.trim() ?? 'unknown',
    logicalCores: cpus.length,
    memoryGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    os: `${os.type()} ${os.release()}`,
    node: process.version,
  };
}

const gc = (globalThis as { gc?: () => void }).gc;

/** Retained heap growth caused by `build`, measured after full GCs. Needs `node --expose-gc`. */
export function retainedBytes<T>(build: () => T): { value: T; bytes: number } {
  if (!gc) throw new Error('run with node --expose-gc');
  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  const value = build();
  gc();
  gc();
  return { value, bytes: process.memoryUsage().heapUsed - before };
}

export function time<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** Median of `runs` timings (after one untimed warm-up unless the workload is slow). */
export function bench<T>(fn: () => T, runs: number, warmup = true): { value: T; ms: number } {
  if (warmup) fn();
  const results = Array.from({ length: runs }, () => time(fn));
  results.sort((a, b) => a.ms - b.ms);
  const median = results[Math.floor(results.length / 2)];
  if (!median) throw new RangeError('runs must be >= 1');
  return median;
}

/** Deterministic PRNG for reproducible workloads (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
