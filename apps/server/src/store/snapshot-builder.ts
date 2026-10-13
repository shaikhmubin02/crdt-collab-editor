import { Doc, type DocSnapshot, type Op } from '@collab/crdt';

/** Replica ID used to materialize stored state. Servers never issue ops, so it never collides. */
export const MATERIALIZER_REPLICA = '_materializer';

/** Materialize a document from a snapshot plus later ops. */
export function materialize(
  snapshot: DocSnapshot | null,
  ops: readonly Op[],
  replica: string,
): Doc {
  const doc = snapshot ? Doc.fromSnapshot(snapshot, replica) : new Doc(replica);
  doc.applyAll(ops);
  return doc;
}

/**
 * Build the next snapshot. Refuses if any op is left buffered: the snapshot would claim to cover
 * it (by log position) without containing it, and a later load would silently lose it. Stored
 * ops are written only after the server integrated them, so this indicates corruption.
 */
export function buildSnapshot(previous: DocSnapshot | null, ops: readonly Op[]): DocSnapshot {
  const doc = materialize(previous, ops, MATERIALIZER_REPLICA);
  if (doc.pendingCount > 0) {
    throw new Error(
      `refusing to snapshot: ${String(doc.pendingCount)} stored ops have missing dependencies`,
    );
  }
  return doc.toSnapshot();
}
