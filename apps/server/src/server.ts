import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CloseCode,
  encode,
  MAX_CLIENT_FRAME_BYTES,
  parseClientMessage,
  ProtocolError,
  type ClientMessage,
} from '@collab/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { Connection, type BackpressureConfig } from './connection.ts';
import type { Fanout } from './fanout.ts';
import { silentLogger, type Logger } from './log.ts';
import { Metrics } from './metrics.ts';
import { Room } from './room.ts';
import type { DocStore } from './store/store.ts';

export interface ServerOptions {
  readonly store: DocStore;
  readonly port?: number;
  readonly host?: string;
  readonly fanout?: Fanout | null;
  readonly log?: Logger;
  readonly metrics?: Metrics;
  readonly snapshotEvery?: number;
  /** Storage catch-up poll interval; defaults to 2000 ms when a fanout is configured, else off. */
  readonly catchUpMs?: number | null;
  /** Keep a room loaded this long after its last client leaves. */
  readonly roomIdleMs?: number;
  readonly helloTimeoutMs?: number;
  readonly heartbeatMs?: number;
  readonly backpressure?: Partial<BackpressureConfig>;
  /** Token bucket for incoming ops per connection: burst capacity and sustained ops/second. */
  readonly rateLimit?: { readonly burst: number; readonly perSecond: number };
}

export interface SyncServer {
  readonly port: number;
  readonly metrics: Metrics;
  /** Loaded rooms (for tests and diagnostics). */
  room(docId: string): Promise<Room> | undefined;
  close(): Promise<void>;
}

const DEFAULT_BACKPRESSURE: BackpressureConfig = {
  highWaterBytes: 1 << 20,
  maxQueuedOps: 200_000,
  maxStallMs: 15_000,
};

export async function startServer(options: ServerOptions): Promise<SyncServer> {
  const log = options.log ?? silentLogger;
  const metrics = options.metrics ?? new Metrics();
  const backpressure = { ...DEFAULT_BACKPRESSURE, ...options.backpressure };
  const rateLimit = options.rateLimit ?? { burst: 20_000, perSecond: 5_000 };
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000;
  const roomIdleMs = options.roomIdleMs ?? 30_000;
  const rooms = new Map<string, Promise<Room>>();
  const idleTimers = new Map<string, NodeJS.Timeout>();
  const connections = new Set<Connection>();

  metrics.gauge('sync_connections', () => connections.size);
  metrics.gauge('sync_rooms', () => rooms.size);

  const roomDeps = {
    store: options.store,
    metrics,
    log,
    snapshotEvery: options.snapshotEvery ?? 1000,
    fanout: options.fanout ?? null,
    catchUpMs: options.catchUpMs !== undefined ? options.catchUpMs : options.fanout ? 2000 : null,
    onFailed: (room: Room) => rooms.delete(room.id),
  };

  const getRoom = (docId: string): Promise<Room> => {
    const timer = idleTimers.get(docId);
    if (timer) {
      clearTimeout(timer);
      idleTimers.delete(docId);
    }
    let room = rooms.get(docId);
    if (!room) {
      room = Room.load(docId, roomDeps);
      rooms.set(docId, room);
      room.catch(() => rooms.delete(docId));
    }
    return room;
  };

  const scheduleUnload = (room: Room) => {
    if (room.clients.size > 0 || idleTimers.has(room.id)) return;
    idleTimers.set(
      room.id,
      setTimeout(() => {
        idleTimers.delete(room.id);
        if (room.clients.size > 0) return;
        rooms.delete(room.id);
        room.close().catch((error: unknown) => {
          log.log('error', 'room close failed', { doc: room.id, error: String(error) });
        });
      }, roomIdleMs),
    );
  };

  const http: Server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    } else if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
    } else {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({
    server: http,
    path: '/sync',
    maxPayload: MAX_CLIENT_FRAME_BYTES,
  });

  wss.on('connection', (socket: WebSocket) => {
    const conn = new Connection(socket, backpressure, metrics);
    connections.add(conn);
    metrics.inc('sync_connections_total');
    let room: Room | null = null;
    let state: 'hello' | 'joining' | 'joined' = 'hello';
    const early: ClientMessage[] = [];
    let alive = true;
    let tokens = rateLimit.burst;
    let refilledAt = Date.now();

    const reject = (code: 'bad_message' | 'bad_op' | 'forbidden', message: string) => {
      metrics.inc('sync_rejected_messages_total');
      socket.send(encode({ type: 'error', code, message }));
      conn.close(CloseCode.BadMessage, message.slice(0, 100));
    };

    const helloTimer = setTimeout(() => {
      if (state === 'hello') reject('bad_message', 'expected hello');
    }, helloTimeoutMs);

    const handle = (msg: ClientMessage) => {
      if (!room) return;
      switch (msg.type) {
        case 'hello':
          reject('bad_message', 'duplicate hello');
          return;
        case 'ops': {
          const now = Date.now();
          tokens = Math.min(
            rateLimit.burst,
            tokens + ((now - refilledAt) / 1000) * rateLimit.perSecond,
          );
          refilledAt = now;
          tokens -= msg.ops.length;
          if (tokens < 0) {
            metrics.inc('sync_rate_limited_total');
            reject('forbidden', 'rate limit exceeded');
            return;
          }
          const foreign = msg.ops.find(
            (op) => op.id.replica !== conn.replica && !conn.owns.has(op.id.replica),
          );
          if (foreign) {
            reject('forbidden', `not allowed to send ops for replica ${foreign.id.replica}`);
            return;
          }
          room.receiveOps(conn, msg.ops, msg.trace);
          return;
        }
        case 'presence':
          room.receivePresence(conn, msg.cursor);
          return;
      }
    };

    socket.on('message', (data, isBinary) => {
      if (conn.closed) return;
      if (isBinary) {
        reject('bad_message', 'binary frames are not supported');
        return;
      }
      let msg: ClientMessage;
      try {
        msg = parseClientMessage(messageText(data));
      } catch (error) {
        reject('bad_message', error instanceof ProtocolError ? error.message : 'invalid message');
        return;
      }
      if (state === 'joined') {
        handle(msg);
      } else if (state === 'joining') {
        if (early.length > 1000) reject('bad_message', 'too many messages before welcome');
        else early.push(msg);
      } else if (msg.type !== 'hello') {
        reject('bad_message', 'expected hello');
      } else {
        clearTimeout(helloTimer);
        state = 'joining';
        conn.replica = msg.replica;
        conn.user = msg.user;
        for (const r of msg.owns) conn.owns.add(r);
        getRoom(msg.doc).then(
          (r) => {
            if (conn.closed) {
              scheduleUnload(r);
              return;
            }
            room = r;
            r.join(conn, msg.vv);
            state = 'joined';
            for (const m of early.splice(0)) handle(m);
          },
          (error: unknown) => {
            log.log('error', 'room load failed', { doc: msg.doc, error: String(error) });
            socket.send(
              encode({ type: 'error', code: 'unavailable', message: 'document unavailable' }),
            );
            conn.close(1011, 'document unavailable');
          },
        );
      }
    });

    socket.on('pong', () => {
      alive = true;
    });
    heartbeats.set(conn, () => {
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    });

    conn.onClose = () => {
      clearTimeout(helloTimer);
      connections.delete(conn);
      heartbeats.delete(conn);
      if (room) {
        room.leave(conn);
        scheduleUnload(room);
      }
    };
    socket.on('close', () => {
      conn.markClosed();
    });
    socket.on('error', (error) => {
      log.log('warn', 'socket error', { error: String(error) });
    });
  });

  const heartbeats = new Map<Connection, () => void>();
  const heartbeatTimer = setInterval(() => {
    for (const beat of heartbeats.values()) beat();
  }, options.heartbeatMs ?? 30_000);
  // Drives stall detection and retries writes for backed-up connections.
  const TICK_MS = 100;
  const flushTimer = setInterval(() => {
    for (const conn of connections) conn.tick(TICK_MS);
  }, TICK_MS);

  await new Promise<void>((resolve) =>
    http.listen(options.port ?? 0, options.host ?? '0.0.0.0', resolve),
  );
  const { port } = http.address() as AddressInfo;
  log.log('info', 'listening', { port });

  return {
    port,
    metrics,
    room: (docId) => rooms.get(docId),
    async close() {
      clearInterval(heartbeatTimer);
      clearInterval(flushTimer);
      for (const timer of idleTimers.values()) clearTimeout(timer);
      for (const conn of connections) conn.close(CloseCode.GoingAway, 'server shutting down');
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
      const loaded = await Promise.allSettled(rooms.values());
      await Promise.all(loaded.flatMap((r) => (r.status === 'fulfilled' ? [r.value.drain()] : [])));
      await new Promise<void>((resolve) =>
        http.close(() => {
          resolve();
        }),
      );
    },
  };
}

/** Text payload of a ws message, whichever of ws's buffer representations it arrived in. */
export function messageText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
