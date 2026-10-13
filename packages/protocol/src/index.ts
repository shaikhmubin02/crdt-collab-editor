import {
  InvalidOpError,
  isReplicaId,
  parseOp,
  ROOT,
  type DocSnapshot,
  type Id,
  type Op,
  type ReplicaId,
  type VersionVector,
} from '@collab/crdt';

/**
 * Wire protocol between editor clients and the sync server: JSON text frames over one WebSocket
 * per open document.
 *
 *   client                                server
 *     | hello {doc, replica, owns, vv} -->  |   join room; server diffs version vectors
 *     | <-- welcome {vv, ops | snapshot}    |   everything the client is missing
 *     | ops {ops} ----------------------->  |   the client's unsynced ops (opsSince(welcome.vv))
 *     | <-- ack {vv}                        |   once those ops are durably stored
 *     | <-- ops {ops}                       |   other clients' ops, as they're persisted
 *     | presence {cursor} <-------------->  |   cursors/user list: best effort, latest wins
 */
export const PROTOCOL_VERSION = 1;

/** Largest client-to-server frame. Bigger batches are split by the client. */
export const MAX_CLIENT_FRAME_BYTES = 1 << 20;
/** Largest server-to-client frame (a welcome snapshot of a large document). */
export const MAX_SERVER_FRAME_BYTES = 64 << 20;
/** Largest number of ops in one frame. */
export const MAX_OPS_PER_FRAME = 5_000;

export interface User {
  readonly name: string;
  /** CSS hex color, e.g. "#e5484d". */
  readonly color: string;
}

/** A cursor or selection, as anchors (see Doc.anchorAt), so it survives concurrent edits. */
export interface Cursor {
  readonly anchor: Id;
  readonly head: Id;
}

export interface Peer {
  readonly replica: ReplicaId;
  readonly user: User;
  readonly cursor: Cursor | null;
}

export type ClientMessage =
  | {
      readonly type: 'hello';
      readonly protocol: number;
      readonly doc: string;
      /** This session's replica ID. */
      readonly replica: ReplicaId;
      /**
       * Replica IDs whose ops this connection may upload besides `replica`: earlier sessions of
       * this client whose offline ops are still unacknowledged.
       */
      readonly owns: readonly ReplicaId[];
      readonly user: User;
      readonly vv: VersionVector;
    }
  | {
      readonly type: 'ops';
      readonly ops: readonly Op[];
      /** Opaque sender timestamp, echoed on the resulting broadcast (latency measurement). */
      readonly trace?: number;
    }
  | { readonly type: 'presence'; readonly cursor: Cursor | null };

export type ServerMessage =
  | {
      readonly type: 'welcome';
      /** The server's version vector, so the client can compute what to upload. */
      readonly vv: VersionVector;
      /** For a client with an empty version vector: the whole document in one frame. */
      readonly snapshot: DocSnapshot | null;
      /** Otherwise: the ops the client is missing. May be followed by more `ops` frames. */
      readonly ops: readonly Op[];
      readonly peers: readonly Peer[];
    }
  | { readonly type: 'ops'; readonly ops: readonly Op[]; readonly traces?: readonly number[] }
  /** Ops up to these seqs (for the replicas named) are durably stored on the server. */
  | { readonly type: 'ack'; readonly vv: VersionVector }
  | { readonly type: 'presence'; readonly peer: Peer }
  | { readonly type: 'leave'; readonly replica: ReplicaId }
  | { readonly type: 'error'; readonly code: ErrorCode; readonly message: string };

export type ErrorCode = 'bad_message' | 'bad_op' | 'forbidden' | 'unavailable';

/** WebSocket close codes used by the server (4000-4999 are application-defined). */
export const CloseCode = {
  /** Protocol violation; the client should not retry with the same input. */
  BadMessage: 4400,
  /** The client didn't keep up with the op stream. It may reconnect and resync by version vector. */
  SlowConsumer: 4008,
  /** Another connection took over this replica ID. */
  Replaced: 4009,
  /** Server shutting down; reconnect elsewhere / later. */
  GoingAway: 1001,
} as const;

/** Thrown for malformed or disallowed frames. */
export class ProtocolError extends Error {
  override name = 'ProtocolError';
}

const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
/** Replica IDs starting with "_" are reserved for servers. */
export const isClientReplicaId = (r: unknown): r is ReplicaId =>
  isReplicaId(r) && !r.startsWith('_');

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Parse and validate a client frame. Throws ProtocolError on anything unexpected. */
export function parseClientMessage(raw: string): ClientMessage {
  const msg = parseJson(raw, MAX_CLIENT_FRAME_BYTES);
  switch (msg.type) {
    case 'hello': {
      if (msg.protocol !== PROTOCOL_VERSION) {
        throw new ProtocolError(`unsupported protocol ${String(msg.protocol)}`);
      }
      if (typeof msg.doc !== 'string' || !DOC_ID.test(msg.doc)) throw new ProtocolError('bad doc');
      if (!isClientReplicaId(msg.replica)) throw new ProtocolError('bad replica');
      if (!Array.isArray(msg.owns) || msg.owns.length > 64 || !msg.owns.every(isClientReplicaId)) {
        throw new ProtocolError('bad owns');
      }
      return {
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        doc: msg.doc,
        replica: msg.replica,
        owns: msg.owns,
        user: parseUser(msg.user),
        vv: parseVersionVector(msg.vv),
      };
    }
    case 'ops': {
      const trace = msg.trace;
      if (trace !== undefined && (typeof trace !== 'number' || !Number.isFinite(trace))) {
        throw new ProtocolError('bad trace');
      }
      const ops = parseOps(msg.ops);
      return trace === undefined ? { type: 'ops', ops } : { type: 'ops', ops, trace };
    }
    case 'presence':
      return { type: 'presence', cursor: parseCursor(msg.cursor) };
    default:
      throw new ProtocolError('unknown message type');
  }
}

/** Parse a server frame. The client trusts the server's shape but still validates ops. */
export function parseServerMessage(raw: string): ServerMessage {
  const msg = parseJson(raw, MAX_SERVER_FRAME_BYTES);
  switch (msg.type) {
    case 'welcome':
      return {
        type: 'welcome',
        vv: parseVersionVector(msg.vv),
        snapshot: (msg.snapshot ?? null) as DocSnapshot | null,
        ops: parseOps(msg.ops),
        peers: Array.isArray(msg.peers) ? msg.peers.map(parsePeer) : [],
      };
    case 'ops': {
      const traces = Array.isArray(msg.traces)
        ? msg.traces.filter((t): t is number => typeof t === 'number')
        : undefined;
      const ops = parseOps(msg.ops);
      return traces ? { type: 'ops', ops, traces } : { type: 'ops', ops };
    }
    case 'ack':
      return { type: 'ack', vv: parseVersionVector(msg.vv) };
    case 'presence':
      return { type: 'presence', peer: parsePeer(msg.peer) };
    case 'leave':
      if (!isReplicaId(msg.replica)) throw new ProtocolError('bad replica');
      return { type: 'leave', replica: msg.replica };
    case 'error':
      return {
        type: 'error',
        code: msg.code as ErrorCode,
        message: typeof msg.message === 'string' ? msg.message : '',
      };
    default:
      throw new ProtocolError('unknown message type');
  }
}

function parseJson(raw: string, maxLength: number): Record<string, unknown> {
  if (raw.length > maxLength) throw new ProtocolError('frame too large');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError('not JSON');
  }
  if (!isObject(value)) throw new ProtocolError('frame must be an object');
  return value;
}

function parseOps(value: unknown): Op[] {
  if (!Array.isArray(value)) throw new ProtocolError('ops must be an array');
  if (value.length > MAX_OPS_PER_FRAME) throw new ProtocolError('too many ops in one frame');
  try {
    return value.map(parseOp);
  } catch (e) {
    if (e instanceof InvalidOpError) throw new ProtocolError(`bad op: ${e.message}`);
    throw e;
  }
}

export function parseVersionVector(value: unknown): VersionVector {
  if (!isObject(value)) throw new ProtocolError('vv must be an object');
  const out = new Map<ReplicaId, number>();
  for (const [replica, seq] of Object.entries(value)) {
    if (!isReplicaId(replica)) throw new ProtocolError('bad vv replica');
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
      throw new ProtocolError('bad vv seq');
    }
    out.set(replica, seq);
  }
  return Object.fromEntries(out);
}

function parseUser(value: unknown): User {
  if (!isObject(value)) throw new ProtocolError('bad user');
  const { name, color } = value;
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    throw new ProtocolError('bad user name');
  }
  if (typeof color !== 'string' || !COLOR.test(color)) throw new ProtocolError('bad user color');
  return { name, color };
}

function parseAnchor(value: unknown): Id {
  if (!isObject(value)) throw new ProtocolError('bad anchor');
  const { clock, replica } = value;
  if (clock === 0 && replica === '') return ROOT;
  if (
    typeof clock !== 'number' ||
    !Number.isSafeInteger(clock) ||
    clock < 1 ||
    !isReplicaId(replica)
  ) {
    throw new ProtocolError('bad anchor');
  }
  return { clock, replica };
}

function parseCursor(value: unknown): Cursor | null {
  if (value === null) return null;
  if (!isObject(value)) throw new ProtocolError('bad cursor');
  return { anchor: parseAnchor(value.anchor), head: parseAnchor(value.head) };
}

function parsePeer(value: unknown): Peer {
  if (!isObject(value) || !isReplicaId(value.replica)) throw new ProtocolError('bad peer');
  return { replica: value.replica, user: parseUser(value.user), cursor: parseCursor(value.cursor) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
