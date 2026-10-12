import { describe, expect, it } from 'vitest';
import { Doc } from '../src/doc.ts';
import { ROOT } from '../src/id.ts';
import { InvalidOpError, type Op } from '../src/ops.ts';

/** Deliver every op from `from` that `to` is missing. */
function sync(from: Doc, to: Doc): void {
  to.applyAll(from.opsSince(to.versionVector()));
}

function syncAll(...docs: Doc[]): void {
  for (const a of docs) for (const b of docs) if (a !== b) sync(a, b);
}

describe('local editing', () => {
  it('inserts and deletes at visible positions', () => {
    const doc = new Doc('alice');
    doc.insert(0, 'helo');
    doc.insert(3, 'l');
    expect(doc.toString()).toBe('hello');
    doc.insert(5, ' world');
    doc.delete(0, 6);
    expect(doc.toString()).toBe('world');
    expect(doc.length).toBe(5);
  });

  it('counts positions in visible characters, skipping tombstones', () => {
    const doc = new Doc('alice');
    doc.insert(0, 'abcd');
    doc.delete(1, 2); // tombstones b, c
    doc.insert(1, 'X'); // between a and d
    expect(doc.toString()).toBe('aXd');
  });

  it('issues contiguous seqs and increasing clocks', () => {
    const doc = new Doc('alice');
    const ops = [...doc.insert(0, 'ab'), ...doc.delete(0, 1)];
    expect(ops.map((op) => op.seq)).toEqual([1, 2, 3]);
    expect(ops.map((op) => op.id.clock)).toEqual([1, 2, 3]);
    expect(doc.versionVector()).toEqual({ alice: 3 });
  });

  it('rejects out-of-range positions', () => {
    const doc = new Doc('alice');
    doc.insert(0, 'abc');
    expect(() => doc.insert(4, 'x')).toThrow(RangeError);
    expect(() => doc.insert(-1, 'x')).toThrow(RangeError);
    expect(() => doc.delete(2, 2)).toThrow(RangeError);
    expect(() => doc.delete(1.5, 1)).toThrow(RangeError);
  });

  it('rejects invalid replica IDs', () => {
    expect(() => new Doc('')).toThrow(RangeError);
    expect(() => new Doc('has space')).toThrow(RangeError);
  });
});

describe('concurrent edits', () => {
  it('orders concurrent inserts at the same position by ID, identically on both replicas', () => {
    const alice = new Doc('alice');
    const bob = new Doc('bob');
    alice.insert(0, 'A');
    bob.insert(0, 'B');
    syncAll(alice, bob);
    // Equal clocks (1); 'bob' > 'alice', and the greater ID goes first.
    expect(alice.toString()).toBe('BA');
    expect(bob.toString()).toBe('BA');
  });

  it('does not interleave concurrently typed runs at the same position', () => {
    const alice = new Doc('alice');
    const bob = new Doc('bob');
    alice.insert(0, 'Hi ');
    syncAll(alice, bob);
    alice.insert(3, 'Alice');
    bob.insert(3, 'Bob');
    syncAll(alice, bob);
    expect(alice.toString()).toBe(bob.toString());
    expect(['Hi AliceBob', 'Hi BobAlice']).toContain(alice.toString());
  });

  it('known RGA limitation: text typed backwards (repeated insert at one position) can interleave', () => {
    const alice = new Doc('alice');
    const bob = new Doc('bob');
    for (const c of 'cba') alice.insert(0, c); // alice ends up with "abc"
    for (const c of 'zyx') bob.insert(0, c); // bob ends up with "xyz"
    syncAll(alice, bob);
    // Every char is a sibling under ROOT, ordered purely by ID, so the runs mix.
    expect(alice.toString()).toBe('xaybzc');
    expect(bob.toString()).toBe('xaybzc');
  });

  it('keeps an insert whose origin was concurrently deleted', () => {
    const alice = new Doc('alice');
    const bob = new Doc('bob');
    alice.insert(0, 'abc');
    syncAll(alice, bob);
    alice.delete(1, 1); // delete b
    bob.insert(2, 'X'); // after b
    syncAll(alice, bob);
    expect(alice.toString()).toBe('aXc');
    expect(bob.toString()).toBe('aXc');
  });

  it('treats concurrent deletes of the same character as one', () => {
    const alice = new Doc('alice');
    const bob = new Doc('bob');
    alice.insert(0, 'abc');
    syncAll(alice, bob);
    alice.delete(1, 1);
    bob.delete(1, 1);
    syncAll(alice, bob);
    expect(alice.toString()).toBe('ac');
    expect(bob.toString()).toBe('ac');
    expect(alice.length).toBe(2);
  });

  it('converges across three replicas with a relay', () => {
    const [a, b, c] = [new Doc('a'), new Doc('b'), new Doc('c')];
    a.insert(0, 'base');
    sync(a, b);
    b.insert(4, '-b');
    c.insert(0, 'c-');
    sync(b, c); // c learns a's and b's ops via b
    a.delete(0, 1);
    syncAll(a, b, c);
    expect(new Set([a, b, c].map(String)).size).toBe(1);
  });
});

describe('delivery: any order, duplicates, buffering', () => {
  it('buffers an insert until its origin arrives', () => {
    const alice = new Doc('alice');
    const [h, i] = alice.insert(0, 'hi') as [Op, Op];
    const bob = new Doc('bob');
    expect(bob.apply(i)).toEqual([]);
    expect(bob.pendingCount).toBe(1);
    expect(bob.apply(h)).toEqual([h, i]);
    expect(bob.toString()).toBe('hi');
    expect(bob.pendingCount).toBe(0);
  });

  it('buffers a delete that arrives before the insert it targets', () => {
    const alice = new Doc('alice');
    const [ins] = alice.insert(0, 'x');
    const [del] = alice.delete(0, 1);
    const bob = new Doc('bob');
    bob.apply(del as Op);
    expect(bob.toString()).toBe('');
    bob.apply(ins as Op);
    expect(bob.toString()).toBe('');
    expect(bob.versionVector()).toEqual({ alice: 2 });
  });

  it('holds back a later op from a replica until the earlier ones arrive (per-replica FIFO)', () => {
    // b2's origin is ROOT, so it doesn't depend on b1 structurally, but integrating it first would
    // leave a gap in bob's version vector.
    const alice = new Doc('alice');
    const [a1] = alice.insert(0, 'a');
    const [a2] = alice.insert(0, 'b');
    const bob = new Doc('bob');
    bob.apply(a2 as Op);
    expect(bob.versionVector()).toEqual({});
    bob.apply(a1 as Op);
    expect(bob.versionVector()).toEqual({ alice: 2 });
    expect(bob.toString()).toBe('ba');
  });

  it('is idempotent: duplicates, whether integrated or buffered, are no-ops', () => {
    const alice = new Doc('alice');
    const [a, b] = alice.insert(0, 'ab') as [Op, Op];
    const bob = new Doc('bob');
    bob.apply(b);
    bob.apply(b);
    expect(bob.pendingCount).toBe(1);
    bob.apply(a);
    expect(bob.apply(a)).toEqual([]);
    expect(bob.apply(b)).toEqual([]);
    expect(bob.toString()).toBe('ab');
  });

  it('ignores its own ops echoed back but rejects never-issued ones', () => {
    const alice = new Doc('alice');
    const [op] = alice.insert(0, 'a');
    expect(alice.apply(op as Op)).toEqual([]);
    expect(alice.toString()).toBe('a');
    const forged: Op = {
      type: 'insert',
      id: { clock: 9, replica: 'alice' },
      seq: 9,
      origin: ROOT,
      char: 'z',
    };
    expect(() => alice.apply(forged)).toThrow(InvalidOpError);
  });

  it('advances the Lamport clock past observed ops so later local inserts sort after them', () => {
    const alice = new Doc('alice');
    alice.insert(0, 'x'.repeat(50));
    const bob = new Doc('bob');
    sync(alice, bob);
    const [op] = bob.insert(0, 'y');
    expect(op?.id.clock).toBe(51);
  });

  it('opsSince returns exactly what a peer is missing, in an applicable order', () => {
    const alice = new Doc('alice');
    const bob = new Doc('bob');
    alice.insert(0, 'abc');
    sync(alice, bob);
    alice.insert(3, 'def');
    bob.insert(0, '>');
    const missing = alice.opsSince(bob.versionVector());
    expect(missing).toHaveLength(3);
    const fresh = new Doc('carol');
    for (const op of alice.opsSince({})) expect(fresh.apply(op)).toEqual([op]);
  });
});

describe('anchors (stable cursor positions)', () => {
  it('tracks a position through concurrent inserts before it', () => {
    const alice = new Doc('alice');
    const bob = new Doc('bob');
    alice.insert(0, 'hello');
    sync(alice, bob);
    const cursor = bob.anchorAt(5); // after 'o'
    alice.insert(0, '>> ');
    sync(alice, bob);
    expect(bob.indexOfAnchor(cursor)).toBe(8);
    expect(bob.indexOfAnchor(ROOT)).toBe(0);
  });

  it('collapses onto the deleted element and is null for unknown elements', () => {
    const doc = new Doc('alice');
    doc.insert(0, 'abc');
    const afterB = doc.anchorAt(2);
    doc.delete(1, 1);
    expect(doc.indexOfAnchor(afterB)).toBe(1);
    expect(doc.indexOfAnchor({ clock: 99, replica: 'zed' })).toBeNull();
  });
});
