import { randomUUID } from 'node:crypto';
import { parseOp, isReplicaId } from '@collab/crdt';
import { Redis } from 'ioredis';
import type { Fanout, FanoutHandler, FanoutMessage } from './fanout.ts';
import type { Logger } from './log.ts';

interface Envelope {
  readonly from: string;
  readonly message: FanoutMessage;
}

/**
 * Fanout over Redis pub/sub: one channel per document, joined by every instance with clients on
 * that document. Pub/sub is fire-and-forget (a disconnected subscriber misses messages), which is
 * acceptable because instances also catch up from Postgres (see Room).
 */
export class RedisFanout implements Fanout {
  readonly #instance = randomUUID();
  readonly #pub: Redis;
  readonly #sub: Redis;
  readonly #log: Logger;
  readonly #handlers = new Map<string, Set<FanoutHandler>>();

  private constructor(pub: Redis, sub: Redis, log: Logger) {
    this.#pub = pub;
    this.#sub = sub;
    this.#log = log;
    sub.on('message', (channel: string, raw: string) => {
      this.#receive(channel, raw);
    });
  }

  static async connect(url: string, log: Logger): Promise<RedisFanout> {
    const pub = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 3 });
    const sub = pub.duplicate();
    await Promise.all([pub.connect(), sub.connect()]);
    for (const [name, client] of [
      ['pub', pub],
      ['sub', sub],
    ] as const) {
      client.on('error', (error: unknown) => {
        log.log('warn', 'redis error', { client: name, error: String(error) });
      });
    }
    return new RedisFanout(pub, sub, log);
  }

  async subscribe(docId: string, handler: FanoutHandler): Promise<() => Promise<void>> {
    const channel = channelFor(docId);
    let set = this.#handlers.get(channel);
    if (!set) {
      this.#handlers.set(channel, (set = new Set()));
      await this.#sub.subscribe(channel);
    }
    set.add(handler);
    return async () => {
      const current = this.#handlers.get(channel);
      if (!current?.delete(handler) || current.size > 0) return;
      this.#handlers.delete(channel);
      await this.#sub.unsubscribe(channel);
    };
  }

  publish(docId: string, message: FanoutMessage): void {
    const envelope: Envelope = { from: this.#instance, message };
    this.#pub.publish(channelFor(docId), JSON.stringify(envelope)).catch((error: unknown) => {
      this.#log.log('warn', 'redis publish failed', { doc: docId, error: String(error) });
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.#sub.quit(), this.#pub.quit()]);
  }

  #receive(channel: string, raw: string): void {
    const handlers = this.#handlers.get(channel);
    if (!handlers) return;
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
      if (envelope.from === this.#instance) return;
      envelope = { from: envelope.from, message: sanitize(envelope.message) };
    } catch (error) {
      this.#log.log('warn', 'bad fanout message', { channel, error: String(error) });
      return;
    }
    for (const handler of handlers) handler(envelope.message);
  }
}

function channelFor(docId: string): string {
  return `collab:doc:${docId}`;
}

/** Messages come from our own instances, but ops are still validated before integration. */
function sanitize(message: FanoutMessage): FanoutMessage {
  switch (message.kind) {
    case 'ops':
      return {
        kind: 'ops',
        ops: message.ops.map(parseOp),
        traces: message.traces.filter((t) => typeof t === 'number'),
      };
    case 'leave':
      if (!isReplicaId(message.replica)) throw new Error('bad replica');
      return message;
    case 'presence':
      return message;
  }
}
