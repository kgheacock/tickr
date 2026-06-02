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
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

// Use DB 2 to avoid key collisions with other test files sharing localhost:6379.
const REDIS_URL =
  (process.env['REDIS_URL'] ?? 'redis://localhost:6379').replace(/\/\d+$/, '') +
  '/2';

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;
let redis: Redis;

const USER_A = '00000000-0000-0000-0000-000000000001';
const USER_B = '00000000-0000-0000-0000-000000000002';
const PORT_A = '00000000-0000-0000-0000-00000000bb01';
const PORT_B = '00000000-0000-0000-0000-00000000bb02';

beforeAll(async () => {
  vi.stubEnv('ROLE', 'api');
  vi.stubEnv('SESSION_SIGNING_KEY', 'test-session-secret-32-bytes-long');

  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();

  const connectionString = container.getConnectionUri();

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

  redis = new Redis(REDIS_URL);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
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
  return { pool: proxy };
});

vi.mock('../../src/redis.js', () => ({
  getRedis: () => redis,
}));

async function buildApp() {
  const app = Fastify();
  const { registerLeaderboardRoute } =
    await import('../../src/routes/leaderboard.js');
  await registerLeaderboardRoute(app);
  return app;
}

async function seedSnapshot(
  takenAt: string,
  equity: number,
  portfolioId: string,
  rank: number,
) {
  await client.query(
    `INSERT INTO valuation_snapshot (id, portfolio_id, taken_at, cash, positions_value, equity)
     VALUES (gen_random_uuid(), $1, $2, $3, 0, $3)
     ON CONFLICT (portfolio_id, taken_at) DO NOTHING`,
    [portfolioId, takenAt, equity],
  );
  const returnPct = (equity - 100_000_000) / 100_000_000;
  await client.query(
    `INSERT INTO leaderboard_row (taken_at, portfolio_id, rank, equity, return_pct)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (taken_at, portfolio_id) DO NOTHING`,
    [takenAt, portfolioId, rank, equity, returnPct],
  );
}

beforeEach(async () => {
  await client.query(`DELETE FROM leaderboard_row`);
  await client.query(`DELETE FROM valuation_snapshot`);
  await client.query(`DELETE FROM position`);
  await client.query(`DELETE FROM portfolio`);
  await client.query(`DELETE FROM app_user`);
  await redis.del(
    'leaderboard:latest',
    'leaderboard:taken_at',
    'metric:lastSnapshotAt',
  );
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('GET /leaderboard', () => {
  it('returns 404 when no snapshot exists', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(res.statusCode).toBe(404);
  });

  it('returns rows ordered by equity DESC from the database', async () => {
    await client.query(
      `INSERT INTO app_user (id, display_name) VALUES ($1, 'Alice'), ($2, 'Bob')`,
      [USER_A, USER_B],
    );
    await client.query(
      `INSERT INTO portfolio (id, user_id, cash) VALUES ($1, $2, 0), ($3, $4, 0)`,
      [PORT_A, USER_A, PORT_B, USER_B],
    );

    const takenAt = '2025-01-15T00:00:00.000Z';
    // Alice has more equity → rank 1
    await seedSnapshot(takenAt, 120_000_000, PORT_A, 1);
    await seedSnapshot(takenAt, 100_000_000, PORT_B, 2);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body) as {
      takenAt: string;
      rows: Array<{
        rank: number;
        portfolioId: string;
        displayName: string;
        isBot: boolean;
        equity: number;
        returnPct: number;
      }>;
      nextCursor: string | null;
    };

    expect(body.takenAt).toBe(takenAt);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.portfolioId).toBe(PORT_A);
    expect(body.rows[0]!.rank).toBe(1);
    expect(body.rows[0]!.displayName).toBe('Alice');
    expect(body.rows[0]!.isBot).toBe(false);
    expect(body.rows[1]!.portfolioId).toBe(PORT_B);
    expect(body.rows[1]!.rank).toBe(2);
    expect(body.nextCursor).toBeNull();
  });

  it('serves from Redis cache on second request', async () => {
    await client.query(
      `INSERT INTO app_user (id, display_name) VALUES ($1, 'Alice')`,
      [USER_A],
    );
    await client.query(
      `INSERT INTO portfolio (id, user_id, cash) VALUES ($1, $2, 0)`,
      [PORT_A, USER_A],
    );

    const takenAt = '2025-01-15T00:00:00.000Z';
    await seedSnapshot(takenAt, 100_000_000, PORT_A, 1);

    const app = await buildApp();

    // First request — populates cache.
    const res1 = await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(res1.statusCode).toBe(200);

    // Verify cache was written.
    const cached = await redis.get('leaderboard:latest');
    expect(cached).not.toBeNull();

    // Drop all DB rows so a DB query would return 404.
    await client.query(`DELETE FROM leaderboard_row`);

    // Second request — must return from cache, not DB.
    const res2 = await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body) as { takenAt: string; rows: unknown[] };
    expect(body2.rows).toHaveLength(1);
  });

  it('rebuilds from DB after Redis cache is cleared', async () => {
    await client.query(
      `INSERT INTO app_user (id, display_name) VALUES ($1, 'Alice')`,
      [USER_A],
    );
    await client.query(
      `INSERT INTO portfolio (id, user_id, cash) VALUES ($1, $2, 0)`,
      [PORT_A, USER_A],
    );

    const takenAt = '2025-01-15T00:00:00.000Z';
    await seedSnapshot(takenAt, 100_000_000, PORT_A, 1);

    const app = await buildApp();

    // Warm cache.
    await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(await redis.get('leaderboard:latest')).not.toBeNull();

    // Clear cache.
    await redis.del('leaderboard:latest', 'leaderboard:taken_at');

    // Request rebuilds from DB and rewarms cache.
    const res = await app.inject({ method: 'GET', url: '/leaderboard' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);

    // Cache should be re-populated.
    expect(await redis.get('leaderboard:latest')).not.toBeNull();
  });
});
