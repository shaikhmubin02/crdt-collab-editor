import { idKey, type Id, type ReplicaId } from './id.ts';
import type { Op } from './ops.ts';

/**
 * Something an op is waiting for: either the previous op from the same replica (per-replica FIFO,
 * which keeps version vectors contiguous) or an element it references (insert origin / delete
 * target).
 */
export type Dependency =
  | { readonly kind: 'seq'; readonly replica: ReplicaId; readonly seq: number }
  | { readonly kind: 'element'; readonly id: Id };

export function dependencyKey(dep: Dependency): string {
  return dep.kind === 'seq' ? `s|${dep.replica}|${String(dep.seq)}` : `e|${idKey(dep.id)}`;
}

/**
 * Ops received before their dependencies, indexed by the one dependency each is blocked on.
 * When that dependency is integrated, `release` hands the waiting ops back; the caller re-checks
 * them, and an op blocked on a second dependency simply gets re-parked under that one.
 * Integrating an op costs O(ops waiting on it), not a scan of the whole buffer.
 */
export class PendingBuffer {
  readonly #ops = new Map<string, Op>();
  readonly #waiting = new Map<string, string[]>();

  get size(): number {
    return this.#ops.size;
  }

  has(op: Op): boolean {
    return this.#ops.has(opKey(op));
  }

  add(op: Op, blockedOn: Dependency): void {
    const key = opKey(op);
    if (this.#ops.has(key)) return;
    this.#ops.set(key, op);
    const depKey = dependencyKey(blockedOn);
    const waiters = this.#waiting.get(depKey);
    if (waiters) waiters.push(key);
    else this.#waiting.set(depKey, [key]);
  }

  /** Remove and return every op that was blocked on `satisfied`. */
  release(satisfied: Dependency): Op[] {
    const depKey = dependencyKey(satisfied);
    const waiters = this.#waiting.get(depKey);
    if (!waiters) return [];
    this.#waiting.delete(depKey);
    const released: Op[] = [];
    for (const key of waiters) {
      const op = this.#ops.get(key);
      if (op) {
        this.#ops.delete(key);
        released.push(op);
      }
    }
    return released;
  }

  values(): IterableIterator<Op> {
    return this.#ops.values();
  }
}

function opKey(op: Op): string {
  return `${op.id.replica}|${String(op.seq)}`;
}
