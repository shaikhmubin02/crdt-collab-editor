import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Doc } from '../src/doc.ts';
import { compareIds } from '../src/id.ts';
import type { Op } from '../src/ops.ts';
import { NaiveDoc } from './reference/naive-doc.ts';
import { numRuns, PROPERTY_TIMEOUT_MS } from './support/runs.ts';
import { play, scenario } from './support/scenario.ts';

const byId = (ops: readonly Op[]) => [...ops].sort((a, b) => compareIds(a.id, b.id));

/**
 * The optimized Doc (runs, blocks, reconstructed op log) must be observationally identical to the
 * naive per-character reference: same text, version vector, buffered-op count and op history on
 * every replica, at every step, under the same adversarial scenarios.
 */
describe('optimized Doc vs naive reference (differential)', () => {
  it(
    'behaves identically on random scenarios',
    () => {
      fc.assert(
        fc.property(scenario, fc.boolean(), ({ replicas, steps, finalOrderSeeds }, flush) => {
          const seeds = flush ? finalOrderSeeds : [];
          const fast = play(replicas, steps, seeds, (r) => new Doc(r));
          const naive = play(replicas, steps, seeds, (r) => new NaiveDoc(r));
          expect(fast.sent).toEqual(naive.sent);
          fast.docs.forEach((d, i) => {
            const ref = naive.docs[i]!;
            expect(d.toString()).toBe(ref.toString());
            expect(d.length).toBe(ref.length);
            expect(d.pendingCount).toBe(ref.pendingCount);
            expect(d.versionVector()).toEqual(ref.versionVector());
            expect(byId(d.opsSince({}))).toEqual(byId(ref.opsSince({})));
            const partial = { r0: 3, r1: 1 };
            expect(byId(d.opsSince(partial))).toEqual(byId(ref.opsSince(partial)));
          });
        }),
        { numRuns: numRuns(500, 0.5) },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});

describe('snapshots', () => {
  it(
    'round-trip through JSON preserving text, version vector and full history',
    () => {
      fc.assert(
        fc.property(scenario, ({ replicas, steps }) => {
          const { docs, sent } = play(replicas, steps, []);
          for (const d of docs) {
            const snapshot = JSON.parse(JSON.stringify(d.toSnapshot())) as ReturnType<
              Doc['toSnapshot']
            >;
            const restored = Doc.fromSnapshot(snapshot, 'restored');
            expect(restored.toString()).toBe(d.toString());
            expect(restored.versionVector()).toEqual(d.versionVector());
            expect(byId(restored.opsSince({}))).toEqual(byId(d.opsSince({})));
            // The restored replica keeps working: it catches up and converges with the original.
            restored.applyAll(sent);
            d.applyAll(sent);
            expect(restored.toString()).toBe(d.toString());
            const [op] = restored.insert(0, 'z');
            d.apply(op!);
            expect(d.toString()).toBe(restored.toString());
          }
        }),
        { numRuns: numRuns(300, 0.3) },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it('refuses to resume a replica ID that appears in the snapshot', () => {
    const doc = new Doc('alice');
    doc.insert(0, 'hi');
    expect(() => Doc.fromSnapshot(doc.toSnapshot(), 'alice')).toThrow(RangeError);
  });
});

describe('run-length encoding', () => {
  it('stores typed text as few runs and re-merges runs as they are deleted', () => {
    const doc = new Doc('alice');
    doc.insert(0, 'hello world');
    expect(doc.stats()).toMatchObject({ runs: 1, chars: 11, length: 11 });
    doc.delete(5, 1); // split around the space
    expect(doc.stats().runs).toBe(3);
    doc.delete(0, 5);
    doc.delete(0, 5); // everything deleted: one tombstone run again
    expect(doc.stats()).toMatchObject({ runs: 1, length: 0, deleteRuns: 3 });
  });

  it('collapses consecutive backspaces into one delete record', () => {
    const doc = new Doc('alice');
    doc.insert(0, 'abcdef');
    for (let i = 6; i > 2; i--) doc.delete(i - 1, 1);
    expect(doc.toString()).toBe('ab');
    expect(doc.stats().deleteRuns).toBe(1);
    const peer = new Doc('bob');
    peer.applyAll(doc.opsSince({}));
    expect(peer.toString()).toBe('ab');
  });
});
