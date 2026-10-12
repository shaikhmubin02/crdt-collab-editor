import type { ReplicaId } from './id.ts';

/**
 * For each replica, the highest `seq` such that ops 1..seq from that replica have all been
 * integrated. Contiguity is what makes "send me everything after my version vector" exact.
 *
 * A plain object so it serializes as JSON. Always read it through `vvGet`, never `vv[replica]`,
 * so a replica named e.g. "constructor" can't read through to Object.prototype.
 */
export type VersionVector = Readonly<Record<ReplicaId, number>>;

export function vvGet(vv: VersionVector, replica: ReplicaId): number {
  return Object.hasOwn(vv, replica) ? (vv[replica] ?? 0) : 0;
}

/** True if `vv` includes op `seq` from `replica`. */
export function vvCovers(vv: VersionVector, replica: ReplicaId, seq: number): boolean {
  return seq <= vvGet(vv, replica);
}

/** True if `a` includes every op `b` includes. */
export function vvDominates(a: VersionVector, b: VersionVector): boolean {
  return Object.keys(b).every((replica) => vvGet(a, replica) >= vvGet(b, replica));
}

/** Pointwise maximum. */
export function vvMerge(a: VersionVector, b: VersionVector): VersionVector {
  const out = new Map<ReplicaId, number>();
  for (const vv of [a, b]) {
    for (const replica of Object.keys(vv)) {
      out.set(replica, Math.max(out.get(replica) ?? 0, vvGet(vv, replica)));
    }
  }
  return Object.fromEntries(out);
}
