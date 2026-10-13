export { LamportClock } from './clock.ts';
export { Doc } from './doc.ts';
export type { DocSnapshot, DocStats } from './doc.ts';
export { compareIds, idEquals, idKey, isReplicaId, isRoot, ROOT } from './id.ts';
export type { Id, ReplicaId } from './id.ts';
export { InvalidOpError, parseOp } from './ops.ts';
export type { DeleteOp, InsertOp, Op } from './ops.ts';
export { vvCovers, vvDominates, vvGet, vvMerge } from './version-vector.ts';
export type { VersionVector } from './version-vector.ts';
