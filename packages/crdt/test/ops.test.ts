import { describe, expect, it } from 'vitest';
import { InvalidOpError, parseOp } from '../src/ops.ts';

const insert = {
  type: 'insert',
  id: { clock: 5, replica: 'alice' },
  seq: 3,
  origin: { clock: 4, replica: 'bob' },
  char: 'x',
};

describe('parseOp', () => {
  it('accepts well-formed ops and drops unknown fields', () => {
    expect(parseOp({ ...insert, extra: 1 })).toEqual(insert);
    const root = { ...insert, origin: { clock: 0, replica: '' } };
    expect(parseOp(root)).toEqual(root);
    const del = {
      type: 'delete',
      id: { clock: 9, replica: 'a' },
      seq: 1,
      target: { clock: 2, replica: 'b' },
    };
    expect(parseOp(del)).toEqual(del);
  });

  it.each([
    ['non-object', 42],
    ['unknown type', { ...insert, type: 'move' }],
    ['zero seq', { ...insert, seq: 0 }],
    ['fractional clock', { ...insert, id: { clock: 1.5, replica: 'a' } }],
    ['bad replica', { ...insert, id: { clock: 5, replica: 'no spaces' } }],
    ['multi-char insert', { ...insert, char: 'xy' }],
    ['origin not before id', { ...insert, origin: { clock: 5, replica: 'bob' } }],
    ['ROOT-like origin with a replica', { ...insert, origin: { clock: 0, replica: 'bob' } }],
    [
      'delete targeting ROOT',
      { type: 'delete', id: { clock: 2, replica: 'a' }, seq: 1, target: { clock: 0, replica: '' } },
    ],
    [
      'delete target not before id',
      {
        type: 'delete',
        id: { clock: 2, replica: 'a' },
        seq: 1,
        target: { clock: 2, replica: 'b' },
      },
    ],
  ])('rejects %s', (_name, input) => {
    expect(() => parseOp(input)).toThrow(InvalidOpError);
  });
});
