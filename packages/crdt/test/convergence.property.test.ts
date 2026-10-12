import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc } from '../src/doc.ts';
import { numRuns, PROPERTY_TIMEOUT_MS } from './support/runs.ts';
import { play, scenario } from './support/scenario.ts';

describe('convergence (property-based)', () => {
  it(
    'all replicas converge to the same text under any delivery order, with duplicates',
    () => {
      fc.assert(
        fc.property(scenario, ({ replicas, steps, finalOrderSeeds }) => {
          const { docs, sent } = play(replicas, steps, finalOrderSeeds);
          const [first, ...rest] = docs as [Doc, ...Doc[]];
          for (const d of rest) {
            expect(d.toString()).toBe(first.toString());
            expect(d.versionVector()).toEqual(first.versionVector());
          }
          for (const d of docs) expect(d.pendingCount).toBe(0);

          // Oracle: a fresh replica applying every op once, in creation order (which is causal),
          // reaches the same state. Ties the adversarial runs to a simple reference execution.
          const reference = new Doc('reference');
          for (const op of sent) expect(reference.apply(op)).toEqual([op]);
          expect(reference.toString()).toBe(first.toString());
        }),
        { numRuns: numRuns(1000) },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'opsSince between any two replicas brings the receiver up to date',
    () => {
      fc.assert(
        fc.property(scenario, ({ replicas, steps }) => {
          // No final flush: replicas are left in arbitrary partial states.
          const { docs } = play(replicas, steps, []);
          const [a, b] = docs as [Doc, Doc];
          b.applyAll(a.opsSince(b.versionVector()));
          a.applyAll(b.opsSince(a.versionVector()));
          // Partial deliveries may have left ops buffered whose dependencies only a third replica
          // holds, so compare after pulling from everyone.
          for (const d of docs) {
            a.applyAll(d.opsSince(a.versionVector()));
            b.applyAll(d.opsSince(b.versionVector()));
          }
          expect(b.toString()).toBe(a.toString());
          expect(a.pendingCount).toBe(0);
          expect(b.pendingCount).toBe(0);
        }),
        { numRuns: numRuns(500) },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
