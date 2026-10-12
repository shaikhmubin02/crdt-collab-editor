import { Doc } from '../../src/doc.ts';
import type { Op } from '../../src/ops.ts';
import type { VersionVector } from '../../src/version-vector.ts';

/** Small, fast, seedable PRNG (mulberry32). Every source of randomness in the sim goes through it. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Partition {
  /** Active for ticks in [start, end). */
  readonly start: number;
  readonly end: number;
  /** Replicas in different groups can't exchange messages while the partition is active. */
  readonly groups: readonly (readonly number[])[];
}

export interface SimConfig {
  readonly seed: number;
  readonly replicas: number;
  /** Ticks during which replicas edit. */
  readonly editTicks: number;
  /** Per replica, per tick. */
  readonly editProbability: number;
  readonly minLatency: number;
  readonly maxLatency: number;
  readonly dropRate: number;
  readonly duplicateRate: number;
  readonly partitions: readonly Partition[];
  /** Every this many ticks, each replica asks one random peer for what it's missing. */
  readonly antiEntropyEvery: number;
}

type Message = { kind: 'ops'; ops: readonly Op[] } | { kind: 'sync'; vv: VersionVector };

interface Envelope {
  readonly from: number;
  readonly to: number;
  readonly message: Message;
}

export interface SimResult {
  readonly docs: readonly Doc[];
  readonly converged: boolean;
  /** Tick at which all replicas reached the same version vector, or null. */
  readonly convergedAt: number | null;
  readonly stats: {
    readonly opsCreated: number;
    readonly messagesSent: number;
    readonly messagesDropped: number;
    readonly messagesDuplicated: number;
  };
}

/**
 * Deterministic discrete-time network simulation. Replicas broadcast their ops as they edit;
 * every message independently gets a random latency (so messages reorder), may be dropped, may be
 * duplicated, and is lost if a partition separates sender and receiver at delivery time. Dropped
 * ops are recovered only by anti-entropy: periodic version-vector pulls, the same mechanism the
 * sync server uses on reconnect.
 *
 * After `editTicks`, edits stop and partitions heal; the network keeps its drop/duplicate/latency
 * behaviour and the sim runs until every replica has the same version vector, or gives up.
 */
export function simulate(config: SimConfig, maxSettleTicks = 10_000): SimResult {
  const random = prng(config.seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const docs = Array.from({ length: config.replicas }, (_, i) => new Doc(`n${String(i)}`));
  const inFlight = new Map<number, Envelope[]>();
  const stats = { opsCreated: 0, messagesSent: 0, messagesDropped: 0, messagesDuplicated: 0 };

  const partitioned = (a: number, b: number, tick: number) =>
    tick < config.editTicks &&
    config.partitions.some(
      (p) =>
        tick >= p.start &&
        tick < p.end &&
        p.groups.findIndex((g) => g.includes(a)) !== p.groups.findIndex((g) => g.includes(b)),
    );

  const send = (from: number, to: number, message: Message, tick: number) => {
    stats.messagesSent++;
    if (random() < config.dropRate) {
      stats.messagesDropped++;
      return;
    }
    const copies = random() < config.duplicateRate ? 2 : 1;
    if (copies === 2) stats.messagesDuplicated++;
    for (let c = 0; c < copies; c++) {
      const at = tick + randInt(config.minLatency, config.maxLatency);
      const queue = inFlight.get(at) ?? [];
      queue.push({ from, to, message });
      inFlight.set(at, queue);
    }
  };

  const deliver = (tick: number) => {
    const due = inFlight.get(tick);
    if (!due) return;
    inFlight.delete(tick);
    // Messages due in the same tick arrive in random order.
    for (let i = due.length - 1; i > 0; i--) {
      const j = randInt(0, i);
      [due[i], due[j]] = [due[j]!, due[i]!];
    }
    for (const { from, to, message } of due) {
      if (partitioned(from, to, tick)) {
        stats.messagesDropped++;
        continue;
      }
      const doc = docs[to]!;
      if (message.kind === 'ops') doc.applyAll(message.ops);
      else send(to, from, { kind: 'ops', ops: doc.opsSince(message.vv) }, tick);
    }
  };

  const edit = (i: number, tick: number) => {
    const doc = docs[i]!;
    let ops: readonly Op[];
    if (doc.length > 0 && random() < 0.3) {
      const at = randInt(0, doc.length - 1);
      ops = doc.delete(at, randInt(1, Math.min(3, doc.length - at)));
    } else {
      const len = randInt(1, 4);
      let text = '';
      for (let k = 0; k < len; k++) text += String.fromCharCode(97 + randInt(0, 3));
      ops = doc.insert(randInt(0, doc.length), text);
    }
    stats.opsCreated += ops.length;
    for (let j = 0; j < docs.length; j++) if (j !== i) send(i, j, { kind: 'ops', ops }, tick);
  };

  const antiEntropy = (tick: number) => {
    for (let i = 0; i < docs.length; i++) {
      const peer = (i + randInt(1, docs.length - 1)) % docs.length;
      send(i, peer, { kind: 'sync', vv: docs[i]!.versionVector() }, tick);
    }
  };

  // Key order differs between replicas (it's arrival order), so compare canonically.
  const canonical = (vv: VersionVector) => JSON.stringify(Object.entries(vv).sort());
  const allEqual = () => {
    const first = canonical(docs[0]!.versionVector());
    return docs.every((d) => canonical(d.versionVector()) === first && d.pendingCount === 0);
  };

  let tick = 0;
  for (; tick < config.editTicks; tick++) {
    deliver(tick);
    for (let i = 0; i < docs.length; i++) if (random() < config.editProbability) edit(i, tick);
    if (tick % config.antiEntropyEvery === 0) antiEntropy(tick);
  }
  const settleBy = tick + maxSettleTicks;
  let convergedAt: number | null = null;
  for (; tick < settleBy; tick++) {
    deliver(tick);
    if (allEqual()) {
      convergedAt = tick;
      break;
    }
    if (tick % config.antiEntropyEvery === 0) antiEntropy(tick);
  }
  return { docs, converged: convergedAt !== null, convergedAt, stats };
}
