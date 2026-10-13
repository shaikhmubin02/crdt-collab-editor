/**
 * CRDT throughput and memory benchmarks.
 *
 *   bench/fetch-traces.sh
 *   node --expose-gc bench/crdt.bench.ts --impl=optimized   # the shipped Doc
 *   node --expose-gc bench/crdt.bench.ts --impl=naive       # the frozen reference implementation
 *
 * Results are printed and written to bench/results/crdt-<impl>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { Doc } from '../packages/crdt/src/index.ts';
import type { Op } from '../packages/crdt/src/index.ts';
import { NaiveDoc } from '../packages/crdt/test/reference/naive-doc.ts';
import { bench, loadTrace, machine, prng, retainedBytes, time, type Trace } from './lib.ts';

interface TextCrdt {
  readonly length: number;
  insert(index: number, text: string): readonly Op[];
  delete(index: number, count: number): readonly Op[];
  apply(op: Op): readonly Op[];
  toString(): string;
}

const { values } = parseArgs({
  options: {
    impl: { type: 'string', default: 'optimized' },
    size: { type: 'string', default: '100000' },
  },
});
const impl = values.impl;
if (impl !== 'optimized' && impl !== 'naive') throw new Error('--impl must be optimized|naive');
const make = (replica: string): TextCrdt =>
  impl === 'naive' ? new NaiveDoc(replica) : new Doc(replica);
const N = Number(values.size);
// The naive implementation is O(n) per op; repeating its multi-second runs adds nothing.
const runs = impl === 'naive' ? 1 : 5;

function replay(trace: Trace, doc: TextCrdt, collect?: Op[]): TextCrdt {
  for (const [pos, del, ins] of trace.patches) {
    if (del > 0) {
      const ops = doc.delete(pos, del);
      if (collect) for (const op of ops) collect.push(op);
    }
    if (ins.length > 0) {
      const ops = doc.insert(pos, ins);
      if (collect) for (const op of ops) collect.push(op);
    }
  }
  return doc;
}

function check(actual: string, expected: string, what: string): void {
  if (actual !== expected) throw new Error(`${what}: wrong final text`);
}

const results: Record<string, unknown> = {};
const report = (name: string, data: Record<string, number | string>) => {
  results[name] = data;
  console.log(name.padEnd(36), JSON.stringify(data));
};

// 1. Sequential typing: N single-character inserts at the end.
{
  const { ms } = bench(
    () => {
      const doc = make('a');
      for (let i = 0; i < N; i++) doc.insert(i, 'x');
      return doc;
    },
    runs,
    impl !== 'naive',
  );
  report(`append ${String(N)} chars`, { ms: round(ms), opsPerSec: Math.round(N / (ms / 1000)) });
}

// 2. Random-position typing: no runs to exploit, the worst case for run-length encoding.
{
  const { ms } = bench(
    () => {
      const random = prng(1);
      const doc = make('a');
      for (let i = 0; i < N; i++) doc.insert(Math.floor(random() * (doc.length + 1)), 'x');
      return doc;
    },
    runs,
    impl !== 'naive',
  );
  report(`random insert ${String(N)} chars`, {
    ms: round(ms),
    opsPerSec: Math.round(N / (ms / 1000)),
  });
}

// 3-5. Real editing traces: local replay, remote integration of the resulting ops, memory.
for (const name of ['automerge-paper', 'seph-blog1']) {
  const trace = loadTrace(name);
  const ops: Op[] = [];
  check(replay(trace, make('a'), ops).toString(), trace.endContent, name);

  const local = bench(() => replay(trace, make('a')), runs, impl !== 'naive');
  check(local.value.toString(), trace.endContent, name);
  report(`${name}: local replay`, {
    patches: trace.patches.length,
    ops: ops.length,
    ms: round(local.ms),
    opsPerSec: Math.round(ops.length / (local.ms / 1000)),
  });

  const remote = bench(
    () => {
      const doc = make('b');
      for (const op of ops) doc.apply(op);
      return doc;
    },
    runs,
    impl !== 'naive',
  );
  check(remote.value.toString(), trace.endContent, `${name} remote`);
  report(`${name}: remote integrate`, {
    ops: ops.length,
    ms: round(remote.ms),
    opsPerSec: Math.round(ops.length / (remote.ms / 1000)),
  });

  const { value: doc, bytes } = retainedBytes(() => replay(trace, make('a')));
  const inserted = ops.filter((op) => op.type === 'insert').length;
  report(`${name}: memory`, {
    retainedMiB: round(bytes / 2 ** 20),
    insertedChars: inserted,
    visibleChars: doc.length,
    bytesPerInsertedChar: round(bytes / inserted),
    bytesPerVisibleChar: round(bytes / doc.length),
  });

  const { ms: toStringMs } = time(() => doc.toString());
  report(`${name}: toString`, { ms: round(toStringMs) });
}

mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
const out = new URL(`./results/crdt-${impl}.json`, import.meta.url);
writeFileSync(
  out,
  `${JSON.stringify({ impl, date: new Date().toISOString(), machine: machine(), results }, null, 2)}\n`,
);
console.log(`\nwrote ${out.pathname}`);

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
