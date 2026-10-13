import type { DocSnapshot, Op } from '@collab/crdt';
import { buildSnapshot } from './snapshot-builder.ts';
import type { CompactResult, DocStore, StoredDoc } from './store.ts';

interface MemoryDoc {
  /** Ops in commit order; index + 1 plays the role of the Postgres row id. */
  readonly ops: Op[];
  readonly keys: Set<string>;
  snapshot: { readonly upto: number; readonly data: DocSnapshot } | null;
}

/** In-process store with the same semantics as PostgresStore. For tests and local dev. */
export class MemoryStore implements DocStore {
  readonly #docs = new Map<string, MemoryDoc>();
  /** Test hook: make the next N appends fail, to exercise retry paths. */
  failNextAppends = 0;

  async load(docId: string): Promise<StoredDoc> {
    await Promise.resolve();
    const doc = this.#docs.get(docId);
    if (!doc) return { snapshot: null, ops: [] };
    const upto = doc.snapshot?.upto ?? 0;
    return { snapshot: doc.snapshot?.data ?? null, ops: doc.ops.slice(upto) };
  }

  async append(docId: string, ops: readonly Op[]): Promise<void> {
    await Promise.resolve();
    if (this.failNextAppends > 0) {
      this.failNextAppends--;
      throw new Error('injected append failure');
    }
    const doc = this.#get(docId);
    for (const op of ops) {
      const key = `${op.id.replica}|${String(op.seq)}`;
      if (doc.keys.has(key)) continue;
      doc.keys.add(key);
      doc.ops.push(op);
    }
  }

  async compact(docId: string): Promise<CompactResult | null> {
    await Promise.resolve();
    const doc = this.#docs.get(docId);
    if (!doc) return null;
    const from = doc.snapshot?.upto ?? 0;
    if (doc.ops.length === from) return null;
    const replay = doc.ops.slice(from);
    const data = buildSnapshot(doc.snapshot?.data ?? null, replay);
    doc.snapshot = { upto: doc.ops.length, data };
    return { ops: doc.ops.length, replayed: replay.length };
  }

  async close(): Promise<void> {
    await Promise.resolve();
  }

  /** Test helper: total ops stored for a document. */
  opCount(docId: string): number {
    return this.#docs.get(docId)?.ops.length ?? 0;
  }

  #get(docId: string): MemoryDoc {
    let doc = this.#docs.get(docId);
    if (!doc) this.#docs.set(docId, (doc = { ops: [], keys: new Set(), snapshot: null }));
    return doc;
  }
}
