import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { Redis } from 'ioredis';
import Fastify from 'fastify';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

// Pub/sub is instance-global (not DB-scoped), but use DB 2 to isolate keys
// from other test files sharing localhost:6379.
const REDIS_URL =
  (process.env['REDIS_URL'] ?? 'redis://localhost:6379').replace(/\/\d+$/, '') +
  '/2';
process.env['REDIS_URL'] = REDIS_URL;
process.env['SESSION_SIGNING_KEY'] = 'test-ws-signing-key-32bytes!!!!!';

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;

// Shared singleton used by gateway + publisher (getRedis()).
let redis: Redis;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_ws_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();

  const connectionString = container.getConnectionUri();
  process.env['DATABASE_URL'] = connectionString;

  await runner({
    databaseUrl: connectionString,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
  });

  client = new pg.Client({ connectionString });
  await client.connect();
  pool = new pg.Pool({ connectionString });

  const { getRedis } = await import('../../src/redis.js');
  redis = getRedis();
}, 120_000);

afterAll(async () => {
  await client?.end();
  await pool?.end();
  await container?.stop();
  await redis?.quit();
});

vi.mock('../../src/db/pool.js', async () => {
  const _pg = await import('pg');
  const proxy = new Proxy({} as _pg.Pool, {
    get(_t, prop: string | symbol) {
      const p: _pg.Pool = pool;
      const val = (p as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === 'function' ? val.bind(p) : val;
    },
  });
  return { pool: proxy, closePool: async () => {} };
});

const USER_A = '00000000-0000-0000-0000-0000000000a1';

async function seedUser(id: string, name: string): Promise<void> {
  await client.query(
    `INSERT INTO app_user (id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, name],
  );
}
async function seedSymbol(symbol: string): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true) ON CONFLICT DO NOTHING`,
    [symbol],
  );
}

beforeEach(async () => {
  for (const t of ['price_bar', 'app_user', 'universe_symbol']) {
    await client.query(`DELETE FROM ${t}`);
  }
  await redis.flushdb();
});

// --- test app + helpers ------------------------------------------------------

async function startApp(heartbeatIntervalMs = 30_000): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const { attachWsGateway } = await import('../../src/ws/server.js');

  const app = Fastify({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const gateway = attachWsGateway(app.server, redis, { heartbeatIntervalMs });
  const { port } = app.server.address() as AddressInfo;

  return {
    port,
    close: async () => {
      await gateway.close();
      await app.close();
    },
  };
}

async function makeSession(userId: string): Promise<string> {
  const { createSession } = await import('../../src/auth/session.js');
  const { token } = await createSession(redis, userId);
  return token;
}

function connect(port: number, token?: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: token ? { Cookie: `tickr_sid=${token}` } : {},
  });
}

function onceOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

interface ServerMsg {
  type: string;
  [k: string]: unknown;
}

function collect(ws: WebSocket): {
  messages: ServerMsg[];
  waitFor: (pred: (m: ServerMsg) => boolean, ms?: number) => Promise<ServerMsg>;
} {
  const messages: ServerMsg[] = [];
  const waiters: {
    pred: (m: ServerMsg) => boolean;
    resolve: (m: ServerMsg) => void;
  }[] = [];
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString()) as ServerMsg;
    messages.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.pred(msg)) {
        waiters[i]!.resolve(msg);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    messages,
    waitFor(pred, ms = 10_000) {
      const existing = messages.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise<ServerMsg>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timeout waiting for message')),
          ms,
        );
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
}

/** Give the server a moment to register a subscription (no ack in the protocol). */
function settle(ms = 150): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- tests -------------------------------------------------------------------

describe('ws gateway (platform topics)', () => {
  it('delivers universe.updated to a universe subscriber', async () => {
    await seedUser(USER_A, 'Alice');
    const token = await makeSession(USER_A);

    const app = await startApp();
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);
      const inbox = collect(ws);
      ws.send(
        JSON.stringify({ type: 'subscribe', topic: { kind: 'universe' } }),
      );
      await settle();

      const { publishUniverseUpdated } =
        await import('../../src/events/publisher.js');
      await publishUniverseUpdated(redis, {
        items: [
          {
            symbol: 'AAPL',
            backfilled: true,
            backfilledAt: null,
            firstBarAt: null,
            lastBarAt: null,
          },
        ],
      });

      const msg = await inbox.waitFor((m) => m.type === 'universe.updated');
      const data = msg['data'] as { items: Array<{ symbol: string }> };
      expect(data.items[0]!.symbol).toBe('AAPL');

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('delivers prices.updated narrowed to the subscribed symbols', async () => {
    await seedUser(USER_A, 'Alice');
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    const token = await makeSession(USER_A);

    const app = await startApp();
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);
      const inbox = collect(ws);
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          topic: { kind: 'prices', symbols: ['AAPL'] },
        }),
      );
      await settle();

      const ts = new Date().toISOString();
      const { publishPricesUpdated } =
        await import('../../src/events/publisher.js');
      await publishPricesUpdated(redis, ts, {
        AAPL: [{ ts, open: 1, high: 1, low: 1, close: 18400, volume: null }],
        MSFT: [{ ts, open: 1, high: 1, low: 1, close: 41000, volume: null }],
      });

      const msg = await inbox.waitFor((m) => m.type === 'prices.updated');
      const series = msg['series'] as Record<string, unknown>;
      // Narrowed to the subscribed symbol only.
      expect(Object.keys(series)).toEqual(['AAPL']);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('rejects a prices subscription with an unknown symbol, keeps socket open', async () => {
    await seedUser(USER_A, 'Alice');
    const token = await makeSession(USER_A);

    const app = await startApp();
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);
      const inbox = collect(ws);
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          topic: { kind: 'prices', symbols: ['NOPE'] },
        }),
      );

      const err = await inbox.waitFor((m) => m.type === 'error');
      expect((err['error'] as { code: string }).code).toBe('VALIDATION');
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('rejects an unauthenticated upgrade with 401', async () => {
    const app = await startApp();
    try {
      const ws = connect(app.port); // no cookie
      const err = await new Promise<Error>((resolve) => {
        ws.once('error', resolve);
        ws.once('unexpected-response', (_req, res) => {
          resolve(new Error(`unexpected-response ${res.statusCode}`));
        });
      });
      expect(err.message).toMatch(/401/);
    } finally {
      await app.close();
    }
  });

  it('closes the socket when the session expires mid-connection', async () => {
    await seedUser(USER_A, 'Alice');
    const token = await makeSession(USER_A);

    // Short heartbeat so the session re-check fires quickly.
    const app = await startApp(150);
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);

      const closed = new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
      });

      await redis.del(`session:${token}`);

      const code = await closed;
      expect(code).toBe(4001);
    } finally {
      await app.close();
    }
  });
});
