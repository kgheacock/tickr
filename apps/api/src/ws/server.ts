import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import type { Redis } from 'ioredis';
import type { WsClientMessage, WsTopic, ApiError } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { authenticateUpgrade, readSessionToken } from './auth.js';
import { getSession } from '../auth/session.js';
import {
  topicKey,
  channelToTopicKey,
  MAX_PRICE_SYMBOLS,
  type TopicKey,
} from './topics.js';
import { startSubscriber, type Subscriber } from './subscriber.js';

const WS_PATH = '/ws';

interface GatewayOptions {
  /** Ms between heartbeat ping + session-revalidation ticks. */
  heartbeatIntervalMs?: number;
  /** Ms without a pong before a connection is terminated. */
  staleTimeoutMs?: number;
  /** Max queued outbound messages before the oldest is dropped. */
  maxOutboundQueue?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  console[level](JSON.stringify({ level, component: 'ws', msg, ...extra }));
}

/** Per-connection state attached alongside the raw socket. */
class Connection {
  readonly topics = new Set<TopicKey>();
  /** Symbols requested on the (singular) prices subscription, if any. */
  priceSymbols = new Set<string>();
  lastPongAt = Date.now();
  /** Bounded outbound queue; drained sequentially to apply backpressure. */
  private readonly outbox: string[] = [];
  private draining = false;

  constructor(
    readonly socket: WebSocket,
    readonly userId: string,
    readonly sessionToken: string,
    private readonly maxQueue: number,
  ) {}

  enqueue(payload: string): void {
    if (this.outbox.length >= this.maxQueue) {
      // Drop the oldest message and warn the client it fell behind.
      this.outbox.shift();
      const err: { type: 'error'; error: ApiError['error'] } = {
        type: 'error',
        error: {
          code: 'BACKPRESSURE',
          message: 'Outbound queue overflow; dropping oldest message',
        },
      };
      this.outbox.push(JSON.stringify(err));
    }
    this.outbox.push(payload);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.outbox.length > 0) {
        if (this.socket.readyState !== WebSocket.OPEN) {
          this.outbox.length = 0;
          return;
        }
        const next = this.outbox.shift()!;
        await new Promise<void>((resolve) => {
          this.socket.send(next, (err) => {
            if (err) log('warn', 'send failed', { err: String(err) });
            resolve();
          });
        });
      }
    } finally {
      this.draining = false;
    }
  }
}

export interface WsGateway {
  /** Deliver a published message to every connection subscribed to a topic. */
  fanOut(topicKey: TopicKey, raw: string): void;
  close(): Promise<void>;
}

export function attachWsGateway(
  httpServer: HttpServer,
  redis: Redis,
  options: GatewayOptions = {},
): WsGateway {
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ?? envInt('WS_HEARTBEAT_MS', 30_000);
  const staleTimeoutMs =
    options.staleTimeoutMs ?? envInt('WS_STALE_MS', 60_000);
  const maxOutboundQueue = options.maxOutboundQueue ?? 256;

  const wss = new WebSocketServer({ noServer: true });
  const connections = new Map<WebSocket, Connection>();

  function sendError(socket: WebSocket, error: ApiError['error']): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'error', error }));
    }
  }

  // --- topic subscription validation ---------------------------------------

  async function validatePriceSymbols(
    symbols: string[],
  ): Promise<string[] | null> {
    if (symbols.length === 0 || symbols.length > MAX_PRICE_SYMBOLS) return null;
    const upper = symbols.map((s) => s.toUpperCase());
    const { rows } = await pool.query<{ symbol: string }>(
      `SELECT symbol FROM universe_symbol WHERE symbol = ANY($1)`,
      [upper],
    );
    if (rows.length !== new Set(upper).size) return null;
    return upper;
  }

  async function isLeagueMember(
    leagueId: string,
    userId: string,
  ): Promise<boolean> {
    const { rows } = await pool.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM fs_league_member
          WHERE league_id = $1 AND user_id = $2
       ) AS ok`,
      [leagueId, userId],
    );
    return rows[0]?.ok ?? false;
  }

  async function handleSubscribe(
    conn: Connection,
    topic: WsTopic,
  ): Promise<void> {
    if (topic.kind === 'prices') {
      const valid = await validatePriceSymbols(topic.symbols);
      if (!valid) {
        sendError(conn.socket, {
          code: 'VALIDATION',
          message: `prices topic requires 1–${MAX_PRICE_SYMBOLS} known symbols`,
        });
        return;
      }
      conn.priceSymbols = new Set(valid);
    }
    if (topic.kind === 'draft') {
      // The draft board is league-private — only members may follow it.
      if (!(await isLeagueMember(topic.leagueId, conn.userId))) {
        sendError(conn.socket, {
          code: 'FORBIDDEN',
          message: 'League membership required to follow this draft',
        });
        return;
      }
    }
    conn.topics.add(topicKey(topic));
  }

  function handleUnsubscribe(conn: Connection, topic: WsTopic): void {
    const key = topicKey(topic);
    conn.topics.delete(key);
    if (topic.kind === 'prices') conn.priceSymbols.clear();
  }

  async function handleMessage(conn: Connection, data: Buffer): Promise<void> {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(data.toString()) as WsClientMessage;
    } catch {
      sendError(conn.socket, { code: 'VALIDATION', message: 'Malformed JSON' });
      return;
    }
    if (msg.type === 'subscribe') {
      await handleSubscribe(conn, msg.topic);
    } else if (msg.type === 'unsubscribe') {
      handleUnsubscribe(conn, msg.topic);
    } else {
      sendError(conn.socket, {
        code: 'VALIDATION',
        message: 'Unknown message type',
      });
    }
  }

  // --- upgrade handling -----------------------------------------------------

  function rejectUpgrade(socket: Socket, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  async function onUpgrade(
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const url = req.url ?? '';
    const path = url.split('?')[0];
    if (path !== WS_PATH) return; // not ours — leave for other handlers

    const userId = await authenticateUpgrade(redis, req);
    if (!userId) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    const token = readSessionToken(req)!;

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Connection(ws, userId, token, maxOutboundQueue);
      connections.set(ws, conn);

      ws.on('pong', () => {
        conn.lastPongAt = Date.now();
      });
      ws.on('message', (data: Buffer) => {
        void handleMessage(conn, data).catch((err: unknown) => {
          log('error', 'message handler failed', { err: String(err) });
        });
      });
      ws.on('close', () => {
        connections.delete(ws);
      });
      ws.on('error', () => {
        connections.delete(ws);
      });
    });
  }

  httpServer.on('upgrade', (req, socket, head) => {
    void onUpgrade(req, socket as Socket, head).catch((err: unknown) => {
      log('error', 'upgrade failed', { err: String(err) });
      (socket as Socket).destroy();
    });
  });

  // --- heartbeat + session revalidation -------------------------------------

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const conn of connections.values()) {
      if (now - conn.lastPongAt > staleTimeoutMs) {
        conn.socket.terminate();
        continue;
      }
      void getSession(redis, conn.sessionToken)
        .then((record) => {
          if (record) {
            conn.socket.ping();
            return;
          }
          // Session expired or revoked mid-connection — close the socket.
          sendError(conn.socket, {
            code: 'UNAUTHENTICATED',
            message: 'Session expired',
          });
          conn.socket.close(4001, 'session expired');
        })
        .catch((err: unknown) => {
          log('error', 'session revalidation failed', { err: String(err) });
        });
    }
  }, heartbeatIntervalMs);
  // Don't let the heartbeat keep the process alive on its own.
  heartbeat.unref?.();

  // --- fan-out + subscriber -------------------------------------------------

  const gateway: WsGateway = {
    fanOut(key: TopicKey, raw: string): void {
      for (const conn of connections.values()) {
        if (!conn.topics.has(key)) continue;
        if (key === 'prices') {
          conn.enqueue(filterPrices(raw, conn.priceSymbols));
        } else {
          conn.enqueue(raw);
        }
      }
    },
    async close(): Promise<void> {
      clearInterval(heartbeat);
      await subscriber.close();
      for (const ws of connections.keys()) ws.terminate();
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };

  const subscriber: Subscriber = startSubscriber(redis, (channel, raw) => {
    const key = channelToTopicKey(channel);
    if (key) gateway.fanOut(key, raw);
  });

  log('info', 'ws gateway attached', { path: WS_PATH, heartbeatIntervalMs });
  return gateway;
}

/**
 * Narrow a `prices.updated` message to the symbols a connection subscribed to.
 * Returns the original payload unchanged if it isn't a prices message.
 */
function filterPrices(raw: string, symbols: Set<string>): string {
  try {
    const msg = JSON.parse(raw) as {
      type: string;
      asOf: string;
      series: Record<string, unknown>;
    };
    if (msg.type !== 'prices.updated') return raw;
    const filtered: Record<string, unknown> = {};
    for (const sym of symbols) {
      if (sym in msg.series) filtered[sym] = msg.series[sym];
    }
    return JSON.stringify({ ...msg, series: filtered });
  } catch {
    return raw;
  }
}
