import { isReplicaId, ROOT, type Id } from './id.ts';

/**
 * Insert one UTF-16 code unit immediately after `origin` (or at the start, if origin is ROOT).
 *
 * `id` orders the element against concurrent siblings. `seq` is the issuing replica's own
 * contiguous op counter (1, 2, 3, ...), used for delivery tracking and version vectors. Lamport
 * clocks can't do that job because they jump when a replica observes remote ops.
 */
export interface InsertOp {
  readonly type: 'insert';
  readonly id: Id;
  readonly seq: number;
  readonly origin: Id;
  readonly char: string;
}

/** Tombstone the element `target`. Has its own id/seq so it can be tracked and resent like any op. */
export interface DeleteOp {
  readonly type: 'delete';
  readonly id: Id;
  readonly seq: number;
  readonly target: Id;
}

export type Op = InsertOp | DeleteOp;

/** Thrown by parseOp for input that is not a well-formed op. */
export class InvalidOpError extends Error {
  override name = 'InvalidOpError';
}

/**
 * Validate untrusted input (e.g. a JSON message from the network) and return a well-formed Op
 * containing only known fields. Besides shape, enforces the causal sanity rule that an op's clock
 * is greater than the clock of the element it refers to: a correct replica can only reference
 * elements it has already seen, and RGA's integration is only correct under that rule.
 */
export function parseOp(input: unknown): Op {
  if (!isObject(input)) throw new InvalidOpError('op must be an object');
  const id = parseId(input.id, 'id');
  const seq = input.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) {
    throw new InvalidOpError('seq must be a positive integer');
  }
  switch (input.type) {
    case 'insert': {
      const origin = isRootRef(input.origin) ? ROOT : parseId(input.origin, 'origin');
      const char = input.char;
      if (typeof char !== 'string' || char.length !== 1) {
        throw new InvalidOpError('char must be a single UTF-16 code unit');
      }
      if (origin.clock >= id.clock) throw new InvalidOpError('origin must precede id');
      return { type: 'insert', id, seq, origin, char };
    }
    case 'delete': {
      const target = parseId(input.target, 'target');
      if (target.clock >= id.clock) throw new InvalidOpError('target must precede id');
      return { type: 'delete', id, seq, target };
    }
    default:
      throw new InvalidOpError('type must be "insert" or "delete"');
  }
}

/** A real (non-ROOT) element ID. */
function parseId(input: unknown, field: string): Id {
  if (!isObject(input)) throw new InvalidOpError(`${field} must be an object`);
  const { clock, replica } = input;
  if (typeof clock !== 'number' || !Number.isSafeInteger(clock) || clock < 1) {
    throw new InvalidOpError(`${field}.clock must be a positive integer`);
  }
  if (!isReplicaId(replica)) throw new InvalidOpError(`${field}.replica is not a valid replica ID`);
  return { clock, replica };
}

function isRootRef(input: unknown): boolean {
  return isObject(input) && input.clock === ROOT.clock && input.replica === ROOT.replica;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
