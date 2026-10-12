import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Doc } from '../src/doc.ts';
import { simulate, type SimConfig } from './support/network-sim.ts';
import { numRuns, PROPERTY_TIMEOUT_MS } from './support/runs.ts';

const base: SimConfig = {
  seed: 1,
  replicas: 5,
  editTicks: 400,
  editProbability: 0.15,
  minLatency: 1,
  maxLatency: 20,
  dropRate: 0.1,
  duplicateRate: 0.05,
  partitions: [],
  antiEntropyEvery: 25,
};

function expectConverged(docs: readonly Doc[]): void {
  const text = docs[0]!.toString();
  for (const d of docs) {
    expect(d.toString()).toBe(text);
    expect(d.pendingCount).toBe(0);
  }
}

describe('network simulator', () => {
  it('is deterministic for a given seed', () => {
    const a = simulate({ ...base, seed: 42 });
    const b = simulate({ ...base, seed: 42 });
    expect(a.docs.map(String)).toEqual(b.docs.map(String));
    expect(a.stats).toEqual(b.stats);
    expect(simulate({ ...base, seed: 43 }).docs[0]!.toString()).not.toBe(a.docs[0]!.toString());
  });

  it('converges after a long partition with lossy, reordering, duplicating links', () => {
    const result = simulate({
      ...base,
      seed: 7,
      partitions: [
        {
          start: 20,
          end: 380,
          groups: [
            [0, 1],
            [2, 3, 4],
          ],
        },
      ],
    });
    expect(result.converged).toBe(true);
    expect(result.stats.opsCreated).toBeGreaterThan(500);
    expect(result.stats.messagesDropped).toBeGreaterThan(0);
    expect(result.stats.messagesDuplicated).toBeGreaterThan(0);
    expectConverged(result.docs);
  });

  it(
    'converges for random topologies, partitions and fault rates',
    () => {
      const partition = (replicas: number) =>
        fc
          .record({
            start: fc.nat({ max: 150 }),
            length: fc.integer({ min: 1, max: 150 }),
            assignment: fc.array(fc.nat({ max: 2 }), { minLength: replicas, maxLength: replicas }),
          })
          .map(({ start, length, assignment }) => ({
            start,
            end: start + length,
            groups: [0, 1, 2].map((g) => assignment.flatMap((a, i) => (a === g ? [i] : []))),
          }));

      const config = fc.integer({ min: 2, max: 6 }).chain((replicas) =>
        fc.record({
          seed: fc.integer(),
          replicas: fc.constant(replicas),
          editTicks: fc.constant(200),
          editProbability: fc.double({ min: 0.02, max: 0.3, noNaN: true }),
          minLatency: fc.constant(1),
          maxLatency: fc.integer({ min: 1, max: 40 }),
          dropRate: fc.double({ min: 0, max: 0.4, noNaN: true }),
          duplicateRate: fc.double({ min: 0, max: 0.3, noNaN: true }),
          partitions: fc.array(partition(replicas), { maxLength: 3 }),
          antiEntropyEvery: fc.integer({ min: 5, max: 50 }),
        }),
      );

      fc.assert(
        fc.property(config, (c) => {
          const result = simulate(c);
          expect(result.converged).toBe(true);
          expectConverged(result.docs);
        }),
        // Each case simulates hundreds of ticks, so CI runs 1/20th of FC_NUM_RUNS here.
        { numRuns: numRuns(200, 0.05) },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
