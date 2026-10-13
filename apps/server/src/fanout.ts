import type { Op, ReplicaId } from '@collab/crdt';
import type { Peer } from '@collab/protocol';

/** A message relayed between server instances hosting the same document. */
export type FanoutMessage =
  | { readonly kind: 'ops'; readonly ops: readonly Op[]; readonly traces: readonly number[] }
  | { readonly kind: 'presence'; readonly peer: Peer }
  | { readonly kind: 'leave'; readonly replica: ReplicaId }
  /** "Who is here?": sent by an instance that just opened the document. */
  | { readonly kind: 'who' };

export type FanoutHandler = (message: FanoutMessage) => void;

/**
 * Cross-instance relay (Redis pub/sub in production). Delivery is best effort, at most once:
 * correctness never depends on it, because every instance also repairs gaps from the durable
 * op log (Room.catchUp polls storage). It exists to make propagation fast, not to make it reliable.
 */
export interface Fanout {
  /** Start receiving messages for a document from other instances. Returns an unsubscribe. */
  subscribe(docId: string, handler: FanoutHandler): Promise<() => Promise<void>>;
  publish(docId: string, message: FanoutMessage): void;
  close(): Promise<void>;
}
