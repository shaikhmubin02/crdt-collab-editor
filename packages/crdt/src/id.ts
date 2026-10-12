/**
 * Identifies one replica (one editing session). Must be globally unique: two live replicas sharing
 * an ID would issue colliding element IDs and break convergence.
 */
export type ReplicaId = string;

const REPLICA_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isReplicaId(value: unknown): value is ReplicaId {
  return typeof value === 'string' && REPLICA_ID.test(value);
}

/**
 * Globally unique element ID: a Lamport timestamp tagged with the replica that issued it.
 * Unique because a replica never issues the same clock value twice.
 */
export interface Id {
  readonly clock: number;
  readonly replica: ReplicaId;
}

/**
 * Virtual origin for inserts at the very start of the document. It is never stored as an element
 * and never issued by a clock (real clocks start at 1).
 */
export const ROOT: Id = Object.freeze({ clock: 0, replica: '' });

export function isRoot(id: Id): boolean {
  return id.clock === 0;
}

export function idEquals(a: Id, b: Id): boolean {
  return a.clock === b.clock && a.replica === b.replica;
}

/**
 * Map key for an ID. Unambiguous because the clock is last and an integer, so it can never contain
 * the separator even if the replica ID does.
 */
export function idKey(id: Id): string {
  return `${id.replica}:${String(id.clock)}`;
}

/**
 * Total order over IDs, used by RGA to order concurrent inserts at the same origin.
 * Returns a negative number if a < b, positive if a > b, 0 if equal.
 *
 * Clock first, so an element created after seeing another always sorts after it (the Lamport
 * property RGA's integration relies on). Ties are broken by replica ID, compared by UTF-16 code
 * unit: deliberately not localeCompare, whose result depends on the runtime's locale/ICU data and
 * could differ between replicas.
 */
export function compareIds(a: Id, b: Id): number {
  if (a.clock !== b.clock) return a.clock < b.clock ? -1 : 1;
  if (a.replica === b.replica) return 0;
  return a.replica < b.replica ? -1 : 1;
}
