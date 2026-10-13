import { Doc } from '@collab/crdt';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSegments } from '../lib/segments';
import { diffText } from '../lib/text-diff';

const apply = (prev: string, e: ReturnType<typeof diffText>) =>
  prev.slice(0, e.index) + e.insert + prev.slice(e.index + e.deleteCount);

describe('diffText', () => {
  it('handles typing, backspace, paste and replace', () => {
    expect(diffText('helo', 'hello', 4)).toEqual({ index: 3, deleteCount: 0, insert: 'l' });
    expect(diffText('hello', 'helo', 3)).toEqual({ index: 3, deleteCount: 1, insert: '' });
    expect(diffText('ab', 'aXYZb', 4)).toEqual({ index: 1, deleteCount: 0, insert: 'XYZ' });
    expect(diffText('a big cat', 'a small cat', 7)).toEqual({
      index: 2,
      deleteCount: 3,
      insert: 'small',
    });
  });

  it('uses the caret to place inserts among repeated characters', () => {
    // Typing "a" at position 1 of "aa": the caret ends at 2, so the insert is at 1, not 2.
    expect(diffText('aa', 'aaa', 2)).toEqual({ index: 1, deleteCount: 0, insert: 'a' });
    expect(diffText('aa', 'aaa', 1)).toEqual({ index: 0, deleteCount: 0, insert: 'a' });
    expect(diffText('aa', 'aaa', 3)).toEqual({ index: 2, deleteCount: 0, insert: 'a' });
  });

  it('never splits a surrogate pair', () => {
    const edit = diffText('x😀', 'x😃', 3); // same high surrogate, different low
    expect(edit).toEqual({ index: 1, deleteCount: 2, insert: '😃' });
  });

  it('always produces an edit that reproduces the new text', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.nat(), (prev, next, caret) => {
        expect(apply(prev, diffText(prev, next, caret % (next.length + 1)))).toBe(next);
        expect(apply(prev, diffText(prev, next))).toBe(next);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('buildSegments', () => {
  const peer = (name: string, color: string, anchor: number, head: number) => ({
    replica: name,
    user: { name, color },
    selection: { anchor, head },
  });

  it('splits text at selection boundaries and places carets at heads', () => {
    const segments = buildSegments('hello world', [
      peer('A', '#ff0000', 6, 11),
      peer('B', '#00ff00', 2, 2),
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('hello world');
    expect(segments.find((s) => s.text === 'world')?.highlights).toEqual(['#ff0000']);
    expect(segments.find((s) => s.carets.some((c) => c.name === 'B'))?.text).toBe('llo ');
    // A caret at the very end gets its own empty segment.
    expect(segments.at(-1)).toMatchObject({ text: '', carets: [{ name: 'A' }] });
  });

  it('clamps stale selections and skips peers without one', () => {
    const segments = buildSegments('hi', [
      peer('A', '#ff0000', 0, 50),
      { replica: 'B', user: { name: 'B', color: '#000000' }, selection: null },
    ]);
    expect(segments.map((s) => s.text).join('')).toBe('hi');
  });

  it('feeds a CRDT correctly when replaying a typing session', () => {
    const doc = new Doc('ui');
    let shown = '';
    for (const [next, caret] of [
      ['h', 1],
      ['hi', 2],
      ['hii', 3],
      ['hi', 2],
      ['oh hi', 3],
    ] as const) {
      const e = diffText(shown, next, caret);
      if (e.deleteCount) doc.delete(e.index, e.deleteCount);
      if (e.insert) doc.insert(e.index, e.insert);
      shown = next;
      expect(doc.toString()).toBe(shown);
    }
  });
});
