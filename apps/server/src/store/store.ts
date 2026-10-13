import type { DocSnapshot, Op } from '@collab/crdt';

export interface StoredDoc {
  /** Latest snapshot, or null if none has been taken yet. */
  readonly snapshot: DocSnapshot | null;
  /** Ops appended after that snapshot, in commit order. */
  readonly ops: readonly Op[];
  /** Log position just after the last op returned (pass to `opsAfter`). */
  readonly cursor: string;
}

export interface OpsPage {
  readonly ops: readonly Op[];
  readonly cursor: string;
}

export interface CompactResult {
  /** Total ops covered by the new snapshot. */
  readonly ops: number;
  /** Ops that had to be replayed on top of the previous snapshot to build it. */
  readonly replayed: number;
}

/**
 * Durable storage for documents: an append-only op log plus periodic snapshots.
 * load = latest snapshot + the ops appended after it.
 */
export interface DocStore {
  load(docId: string): Promise<StoredDoc>;
  /**
   * Durably append ops (already integrated by the caller, so causally ordered). Idempotent:
   * an op already stored, identified by (replica, seq), is skipped.
   */
  append(docId: string, ops: readonly Op[]): Promise<void>;
  /** Ops committed after log position `cursor`, in commit order, and the new cursor. */
  opsAfter(docId: string, cursor: string): Promise<OpsPage>;
  /**
   * Build a snapshot from the stored log (not from any server's in-memory state, which may lag
   * other instances) and save it. Returns null if there was nothing new to snapshot.
   */
  compact(docId: string): Promise<CompactResult | null>;
  close(): Promise<void>;
}
