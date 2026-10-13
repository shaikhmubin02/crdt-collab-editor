import { randomUUID } from 'node:crypto';
import { Doc, type Op } from '@collab/crdt';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresStore } from '../src/store/postgres.ts';
import { materialize } from '../src/store/snapshot-builder.ts';

const url = process.env.DATABASE_URL;

/** Runs against a real Postgres when DATABASE_URL is set (CI, or `docker compose up -d postgres`). */
describe.skipIf(!url)('PostgresStore', () => {
  let store: PostgresStore;

  beforeAll(async () => {
    store = new PostgresStore(url ?? '');
    await store.migrate();
  });
  // A fresh document per test instead of truncating tables: no DDL locks, and tests stay
  // independent even if they run concurrently against a shared database.
  let d = '';
  beforeEach(() => {
    d = `test-${randomUUID()}`;
  });
  afterAll(async () => {
    await store.close();
  });

  const text = async (docId: string) => {
    const { snapshot, ops } = await store.load(docId);
    return materialize(snapshot, ops, '_test').toString();
  };

  it('appends and loads ops in commit order', async () => {
    const doc = new Doc('alice');
    await store.append(d, doc.insert(0, 'hello'));
    await store.append(d, doc.delete(0, 1));
    const loaded = await store.load(d);
    expect(loaded.snapshot).toBeNull();
    expect(loaded.ops).toEqual(doc.opsSince({}));
    expect(await text(d)).toBe('ello');
  });

  it('is idempotent on (replica, seq)', async () => {
    const ops = new Doc('alice').insert(0, 'abc');
    await store.append(d, ops);
    await store.append(d, ops);
    expect((await store.load(d)).ops).toHaveLength(3);
  });

  it('round-trips lone surrogate code units exactly', async () => {
    const doc = new Doc('alice');
    const ops: Op[] = doc.insert(0, 'a😀b'); // the emoji is two elements, one per surrogate
    await store.append(d, ops);
    expect(await text(d)).toBe('a😀b');
    // Deleting half a pair leaves a lone surrogate, which still must survive storage.
    await store.append(d, doc.delete(1, 1));
    expect(await text(d)).toBe(doc.toString());
  });

  it('compacts into a snapshot; load = snapshot + later ops', async () => {
    const doc = new Doc('alice');
    await store.append(d, doc.insert(0, 'snapshot'));
    expect(await store.compact(d)).toEqual({ ops: 8, replayed: 8 });
    expect(await store.compact(d)).toBeNull(); // nothing new
    await store.append(d, doc.insert(8, ' + tail'));
    const loaded = await store.load(d);
    expect(loaded.snapshot).not.toBeNull();
    expect(loaded.ops).toHaveLength(7);
    expect(await text(d)).toBe('snapshot + tail');
    expect(await store.compact(d)).toEqual({ ops: 15, replayed: 7 });
  });

  it('keeps every op when appends race compaction', async () => {
    // Each writer appends its own ops in order (as one server room does); writers race each other
    // and compaction.
    const writers = ['a', 'b', 'c'].map((r) => new Doc(r));
    const chains = writers.map(async (w) => {
      for (let i = 0; i < 30; i++) await store.append(d, w.insert(0, String(i % 10)));
    });
    const compactions = Array.from({ length: 6 }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i * 15));
      return store.compact(d);
    });
    await Promise.all([...chains, ...compactions]);
    const merged = new Doc('m');
    for (const w of writers) merged.applyAll(w.opsSince({}));
    expect(await text(d)).toBe(merged.toString());
  });
});
