import fc from 'fast-check';
import { expect } from 'vitest';
import { Doc } from '../../src/doc.ts';
import type { Op } from '../../src/ops.ts';
import type { VersionVector } from '../../src/version-vector.ts';

/**
 * Random concurrent-editing scenarios.
 *
 * A scenario is a random interleaving of local edits on N replicas and partial deliveries: each
 * delivery hands a replica an arbitrary selection of ops sent so far (any order, with repeats,
 * possibly ops it already has, possibly ops whose dependencies it lacks). Edits made after a
 * partial delivery are concurrent with everything not yet delivered, so the scenarios cover
 * arbitrary causal histories. `play` then gives every replica every op in its own random order,
 * with duplicates.
 */

export type Step =
  | { kind: 'insert'; replica: number; at: number; text: string }
  | { kind: 'delete'; replica: number; at: number; len: number }
  | { kind: 'deliver'; replica: number; picks: number[] };

export const MAX_REPLICAS = 4;

// A tiny alphabet makes equal characters common, so convergence can't pass by accident of
// distinct letters lining up.
const text = fc.string({ unit: fc.constantFrom('a', 'b', 'c'), minLength: 1, maxLength: 5 });
const replica = fc.nat({ max: MAX_REPLICAS - 1 });

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('insert' as const), replica, at: fc.nat(), text }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('delete' as const),
      replica,
      at: fc.nat(),
      len: fc.integer({ min: 1, max: 3 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('deliver' as const),
      replica,
      picks: fc.array(fc.nat(), { maxLength: 16, size: 'max' }),
    }),
  },
);

export const scenario = fc.record({
  replicas: fc.integer({ min: 2, max: MAX_REPLICAS }),
  steps: fc.array(step, { minLength: 10, maxLength: 80, size: 'max' }),
  // Per-replica final delivery order: a random key per op, sorted. Extra keys produce duplicates.
  finalOrderSeeds: fc.array(fc.array(fc.nat(), { maxLength: 400, size: 'max' }), {
    minLength: MAX_REPLICAS,
    maxLength: MAX_REPLICAS,
  }),
});

/** The surface shared by the optimized Doc and the naive reference implementation. */
export interface TextCrdt {
  readonly length: number;
  insert(index: number, text: string): Op[];
  delete(index: number, count: number): Op[];
  apply(op: Op): Op[];
  applyAll(ops: Iterable<Op>): Op[];
  opsSince(vv: VersionVector): Op[];
  versionVector(): VersionVector;
  readonly pendingCount: number;
  toString(): string;
}

export interface Outcome<D extends TextCrdt = Doc> {
  docs: D[];
  sent: Op[];
}

export function play<D extends TextCrdt = Doc>(
  replicaCount: number,
  steps: readonly Step[],
  finalOrderSeeds: readonly (readonly number[])[],
  make: (replica: string) => D = (replica) => new Doc(replica) as unknown as D,
): Outcome<D> {
  const docs = Array.from({ length: replicaCount }, (_, i) => make(`r${String(i)}`));
  const sent: Op[] = [];
  const doc = (i: number) => docs[i % replicaCount]!;

  for (const s of steps) {
    const d = doc(s.replica);
    switch (s.kind) {
      case 'insert': {
        const at = s.at % (d.length + 1);
        const before = d.toString();
        sent.push(...d.insert(at, s.text));
        // Intent: a local insert lands exactly where the user typed it.
        expect(d.toString()).toBe(before.slice(0, at) + s.text + before.slice(at));
        break;
      }
      case 'delete': {
        if (d.length === 0) break;
        const at = s.at % d.length;
        const len = Math.min(s.len, d.length - at);
        const before = d.toString();
        sent.push(...d.delete(at, len));
        expect(d.toString()).toBe(before.slice(0, at) + before.slice(at + len));
        break;
      }
      case 'deliver': {
        if (sent.length === 0) break;
        for (const p of s.picks) d.apply(sent[p % sent.length]!);
        break;
      }
    }
  }

  docs.forEach((d, i) => {
    const seeds = finalOrderSeeds[i] ?? [];
    // Every op at least once, plus duplicates, ordered by random keys.
    if (sent.length === 0) return;
    const deliveries = sent.map((op, j) => ({ op, key: seeds[j] ?? j }));
    for (let k = sent.length; k < seeds.length; k++) {
      deliveries.push({ op: sent[k % sent.length]!, key: seeds[k] ?? 0 });
    }
    deliveries.sort((a, b) => a.key - b.key);
    for (const { op } of deliveries) d.apply(op);
  });
  return { docs, sent };
}
