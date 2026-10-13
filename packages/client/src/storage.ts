import { vvGet, type DocSnapshot, type Op, type VersionVector } from '@collab/crdt';

export interface PersistedDoc {
  /** Latest local snapshot of the document (debounced), or null on first open. */
  readonly snapshot: DocSnapshot | null;
  /** Local ops not yet acknowledged by the server, from this and earlier sessions. */
  readonly outbox: readonly Op[];
}

/**
 * Durable client-side state for offline editing.
 *
 * The outbox is written on every local edit; the snapshot only periodically. Recovery is
 * `snapshot` + `outbox`: every local op is in one or the other (or acked, i.e. on the server), and
 * remote ops missing from an older snapshot are simply fetched again by version vector.
 */
export interface ClientStorage {
  load(docId: string): Promise<PersistedDoc>;
  saveSnapshot(docId: string, snapshot: DocSnapshot): Promise<void>;
  appendOutbox(docId: string, ops: readonly Op[]): Promise<void>;
  /** Drop outbox entries covered by `acked`. */
  pruneOutbox(docId: string, acked: VersionVector): Promise<void>;
}

export class MemoryStorage implements ClientStorage {
  readonly #snapshots = new Map<string, DocSnapshot>();
  readonly #outboxes = new Map<string, Op[]>();

  async load(docId: string): Promise<PersistedDoc> {
    await Promise.resolve();
    return {
      snapshot: this.#snapshots.get(docId) ?? null,
      outbox: [...(this.#outboxes.get(docId) ?? [])],
    };
  }

  async saveSnapshot(docId: string, snapshot: DocSnapshot): Promise<void> {
    await Promise.resolve();
    this.#snapshots.set(docId, snapshot);
  }

  async appendOutbox(docId: string, ops: readonly Op[]): Promise<void> {
    await Promise.resolve();
    const outbox = this.#outboxes.get(docId) ?? [];
    outbox.push(...ops);
    this.#outboxes.set(docId, outbox);
  }

  async pruneOutbox(docId: string, acked: VersionVector): Promise<void> {
    await Promise.resolve();
    const outbox = this.#outboxes.get(docId);
    if (outbox) {
      this.#outboxes.set(
        docId,
        outbox.filter((op) => op.seq > vvGet(acked, op.id.replica)),
      );
    }
  }
}

const DB_VERSION = 1;
const SNAPSHOTS = 'snapshots';
const OUTBOX = 'outbox';

/**
 * IndexedDB-backed storage. Outbox entries are keyed by [docId, replica, seq], so concurrent tabs
 * (which always use distinct replica IDs) never overwrite each other's entries, and re-appending
 * an op is idempotent.
 */
export class IndexedDbStorage implements ClientStorage {
  readonly #db: Promise<IDBDatabase>;

  constructor(name = 'collab-editor', factory: IDBFactory = indexedDB) {
    this.#db = new Promise((resolve, reject) => {
      const request = factory.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore(SNAPSHOTS);
        db.createObjectStore(OUTBOX);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error('IndexedDB open failed'));
      };
    });
  }

  async load(docId: string): Promise<PersistedDoc> {
    const db = await this.#db;
    const tx = db.transaction([SNAPSHOTS, OUTBOX], 'readonly');
    const snapshot = request<DocSnapshot | undefined>(tx.objectStore(SNAPSHOTS).get(docId));
    const outbox = request<Op[]>(tx.objectStore(OUTBOX).getAll(outboxRange(docId)));
    await done(tx);
    const ops = await outbox;
    // Keys sort by [docId, replica, seq]: per-replica order is preserved, which is all apply needs.
    return { snapshot: (await snapshot) ?? null, outbox: ops };
  }

  async saveSnapshot(docId: string, snapshot: DocSnapshot): Promise<void> {
    const db = await this.#db;
    const tx = db.transaction(SNAPSHOTS, 'readwrite');
    tx.objectStore(SNAPSHOTS).put(snapshot, docId);
    await done(tx);
  }

  async appendOutbox(docId: string, ops: readonly Op[]): Promise<void> {
    if (ops.length === 0) return;
    const db = await this.#db;
    const tx = db.transaction(OUTBOX, 'readwrite');
    const store = tx.objectStore(OUTBOX);
    for (const op of ops) store.put(op, [docId, op.id.replica, op.seq]);
    await done(tx);
  }

  async pruneOutbox(docId: string, acked: VersionVector): Promise<void> {
    const db = await this.#db;
    const tx = db.transaction(OUTBOX, 'readwrite');
    const store = tx.objectStore(OUTBOX);
    for (const replica of Object.keys(acked)) {
      const upTo = vvGet(acked, replica);
      if (upTo > 0) store.delete(IDBKeyRange.bound([docId, replica, 0], [docId, replica, upTo]));
    }
    await done(tx);
  }
}

function outboxRange(docId: string): IDBKeyRange {
  // Arrays sort after every other key type, so [docId, []] is above any [docId, replica, seq].
  return IDBKeyRange.bound([docId], [docId, []]);
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result as T);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}
