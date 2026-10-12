import { describe, expect, it } from 'vitest';
import { compareIds, idKey, type Id } from '../src/id.ts';

const id = (clock: number, replica: string): Id => ({ clock, replica });
const sign = (a: Id, b: Id) => Math.sign(compareIds(a, b));

describe('compareIds', () => {
  it('orders by clock first', () => {
    expect(sign(id(1, 'z'), id(2, 'a'))).toBe(-1);
    expect(sign(id(5, 'a'), id(3, 'z'))).toBe(1);
  });

  it('breaks clock ties by replica ID', () => {
    expect(sign(id(4, 'alice'), id(4, 'bob'))).toBe(-1);
    expect(sign(id(4, 'bob'), id(4, 'alice'))).toBe(1);
  });

  it('returns 0 only for identical IDs', () => {
    expect(sign(id(7, 'x'), id(7, 'x'))).toBe(0);
  });

  it('compares replica IDs by code unit, independent of locale', () => {
    // 'B' (U+0042) < 'a' (U+0061). A locale-aware compare would put 'a' first and could differ
    // between machines, which would make replicas diverge.
    expect(sign(id(1, 'B'), id(1, 'a'))).toBe(-1);
    expect(sign(id(1, 'ä'), id(1, 'z'))).toBe(1);
  });

  it('is a total order (antisymmetric and transitive) on a small exhaustive set', () => {
    const ids = [1, 2, 3].flatMap((c) => ['', 'a', 'B', 'ab', 'b'].map((r) => id(c, r)));
    for (const a of ids) {
      for (const b of ids) {
        expect(sign(a, b) + sign(b, a)).toBe(0);
        for (const c of ids) {
          if (sign(a, b) < 0 && sign(b, c) < 0) expect(sign(a, c)).toBe(-1);
        }
      }
    }
  });
});

describe('idKey', () => {
  it('is unambiguous even when replica IDs contain the separator', () => {
    expect(idKey(id(2, 'a:1'))).not.toBe(idKey(id(12, 'a')));
    expect(idKey(id(1, 'a:1'))).not.toBe(idKey(id(11, 'a')));
  });
});
