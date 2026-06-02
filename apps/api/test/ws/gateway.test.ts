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
import cookie from '@fastify/cookie';
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

// Shared singleton used by routes + gateway (getRedis()).
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
const USER_B = '00000000-0000-0000-0000-0000000000a2';
const PORT_A = '00000000-0000-0000-0000-0000000000b1';
const PORT_B = '00000000-0000-0000-0000-0000000000b2';

async function seedUser(id: string, name: string): Promise<void> {
  await client.query(
    `INSERT INTO app_user (id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, name],
  );
}
async function seedPortfolio(
  id: string,
  userId: string,
  cash: number,
): Promise<void> {
  await client.query(
    `INSERT INTO portfolio (id, user_id, cash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [id, userId, cash],
  );
}
async function seedSymbol(symbol: string): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true) ON CONFLICT DO NOTHING`,
    [symbol],
  );
}
async function seedPrice(symbol: string, closeCents: number): Promise<void> {
  const ts = new Date();
  ts.setUTCHours(21, 0, 0, 0);
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close)
     VALUES ($1, $2, $3, $3, $3, $3)
     ON CONFLICT (symbol, ts) DO UPDATE SET close = $3`,
    [symbol, ts.toISOString(), closeCents],
  );
}

beforeEach(async () => {
  for (const t of [
    'fill',
    'trade_order',
    'valuation_snapshot',
    'leaderboard_row',
    'position',
    'price_bar',
    'portfolio',
    'app_user',
    'universe_symbol',
  ]) {
    await client.query(`DELETE FROM ${t}`);
  }
  await redis.flushdb();
});

// --- test app + helpers ------------------------------------------------------

interface TestApp {
  port: number;
  close: () => Promise<void>;
}

async function startApp(heartbeatIntervalMs = 30_000): Promise<TestApp> {
  const { registerOrderRoutes } =
    await import('../../src/routes/portfolios/orders.js');
  const { attachWsGateway } = await import('../../src/ws/server.js');

  const app = Fastify({ logger: false });
  await app.register(cookie, {
    secret: process.env['SESSION_SIGNING_KEY']!,
    parseOptions: {},
  });
  await app.register(
    async (api) => {
      await registerOrderRoutes(api);
    },
    { prefix: '/api/v1' },
  );
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

async function makeSession(userId: string): Promise<{
  token: string;
  csrfToken: string;
}> {
  const { createSession } = await import('../../src/auth/session.js');
  const { token, record } = await createSession(redis, userId);
  return { token, csrfToken: record.csrfToken };
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

/** Collect every server message in arrival order. */
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

describe('ws gateway', () => {
  it('delivers order.filled then portfolio.updated after a fill', async () => {
    await seedUser(USER_A, 'Alice');
    await seedPortfolio(PORT_A, USER_A, 100_000_000);
    await seedSymbol('AAPL');
    await seedPrice('AAPL', 20_000);
    const { token, csrfToken } = await makeSession(USER_A);

    const app = await startApp();
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);
      const inbox = collect(ws);
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          topic: { kind: 'portfolio', portfolioId: PORT_A },
        }),
      );
      await settle();

      const res = await fetch(
        `http://127.0.0.1:${app.port}/api/v1/portfolios/${PORT_A}/orders`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `tickr_sid=${token}`,
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify({
            symbol: 'AAPL',
            side: 'buy',
            type: 'market',
            quantity: 10,
            idempotencyKey: 'ws-test-1',
          }),
        },
      );
      expect(res.status).toBe(201);

      await inbox.waitFor((m) => m.type === 'portfolio.updated');

      const types = inbox.messages.map((m) => m.type);
      const filledAt = types.indexOf('order.filled');
      const updatedAt = types.indexOf('portfolio.updated');
      expect(filledAt).toBeGreaterThanOrEqual(0);
      expect(updatedAt).toBeGreaterThanOrEqual(0);
      expect(filledAt).toBeLessThan(updatedAt);

      const filled = inbox.messages.find((m) => m.type === 'order.filled')!;
      expect(filled['portfolioId']).toBe(PORT_A);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects subscribing to another user's portfolio with FORBIDDEN, keeps socket open", async () => {
    await seedUser(USER_A, 'Alice');
    await seedUser(USER_B, 'Bob');
    await seedPortfolio(PORT_B, USER_B, 100_000_000);
    const { token } = await makeSession(USER_A);

    const app = await startApp();
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);
      const inbox = collect(ws);
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          topic: { kind: 'portfolio', portfolioId: PORT_B },
        }),
      );

      const err = await inbox.waitFor((m) => m.type === 'error');
      expect((err['error'] as { code: string }).code).toBe('FORBIDDEN');
      // Socket remains open after a rejected subscription.
      expect(ws.readyState).toBe(WebSocket.OPEN);

      ws.close();
    } finally {
      await app.close();
    }
  });

  it('fans out leaderboard.updated when the snapshot job runs', async () => {
    await seedUser(USER_A, 'Alice');
    await seedPortfolio(PORT_A, USER_A, 100_000_000);
    const { token } = await makeSession(USER_A);

    const app = await startApp();
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);
      const inbox = collect(ws);
      ws.send(
        JSON.stringify({ type: 'subscribe', topic: { kind: 'leaderboard' } }),
      );
      await settle();

      const { runSnapshot } = await import('../../src/jobs/snapshot.js');
      await runSnapshot(redis);

      const msg = await inbox.waitFor((m) => m.type === 'leaderboard.updated');
      const data = msg['data'] as { rows: unknown[] };
      expect(Array.isArray(data.rows)).toBe(true);

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
    const { token } = await makeSession(USER_A);

    // Short heartbeat so the session re-check fires quickly.
    const app = await startApp(150);
    try {
      const ws = connect(app.port, token);
      await onceOpen(ws);

      const closed = new Promise<number>((resolve) => {
        ws.once('close', (code) => resolve(code));
      });

      // Revoke the session out from under the live connection.
      await redis.del(`session:${token}`);

      const code = await closed;
      expect(code).toBe(4001);
    } finally {
      await app.close();
    }
  });
});
