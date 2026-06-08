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
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;
let redis: Redis;

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

beforeAll(async () => {
  vi.stubEnv('ROLE', 'worker');
  vi.stubEnv('MASSIVE_API_KEY', process.env['MASSIVE_API_KEY'] ?? 'test-key');

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

beforeEach(async () => {
  await client.query(`DELETE FROM price_bar`);
  await client.query(`DELETE FROM universe_symbol`);
  vi.restoreAllMocks();
  vi.resetModules();
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

vi.mock('../../src/massive/bucket.js', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  BUCKET_KEY: 'massive:bucket',
}));

// Two 15-minute bars; o/h/l/c in dollars (the job converts to cents).
const BARS = {
  status: 'OK',
  ticker: 'TEST',
  queryCount: 2,
  resultsCount: 2,
  results: [
    { t: 1780000200000, o: 175.0, h: 177.0, l: 174.0, c: 175.5, v: 1000 },
    { t: 1780001100000, o: 175.5, h: 178.0, l: 175.0, c: 176.25, v: 2000 },
  ],
};

function mockFetchBars() {
  return vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(BARS), { status: 200 })),
    );
}

describe('intraday session update', () => {
  it('inserts the session bars for each backfilled symbol only', async () => {
    await client.query(`
      INSERT INTO universe_symbol (symbol, backfilled)
      VALUES ('AAPL', true), ('MSFT', true), ('GOOG', false)
    `);

    vi.stubGlobal('fetch', mockFetchBars());

    const { runIntradayUpdate } =
      await import('../../src/jobs/intraday-update.js');
    await runIntradayUpdate(redis);

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar`,
    );
    // 2 backfilled symbols × 2 bars; GOOG (not backfilled) excluded.
    expect(Number(rows[0]?.count)).toBe(4);
  });

  it('stores prices as cents', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );

    vi.stubGlobal('fetch', mockFetchBars());

    const { runIntradayUpdate } =
      await import('../../src/jobs/intraday-update.js');
    await runIntradayUpdate(redis);

    const { rows } = await client.query<{
      open: number;
      high: number;
      low: number;
      close: number;
    }>(
      `SELECT open, high, low, close FROM price_bar
        WHERE symbol = 'AAPL' ORDER BY ts ASC LIMIT 1`,
    );

    expect(rows[0]?.open).toBe(17500); // 175.00 × 100
    expect(rows[0]?.high).toBe(17700); // 177.00 × 100
    expect(rows[0]?.low).toBe(17400); // 174.00 × 100
    expect(rows[0]?.close).toBe(17550); // 175.50 × 100
  });

  it('running twice inserts no duplicates (ON CONFLICT)', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );

    vi.stubGlobal('fetch', mockFetchBars());

    const { runIntradayUpdate } =
      await import('../../src/jobs/intraday-update.js');
    await runIntradayUpdate(redis);
    await runIntradayUpdate(redis);

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'AAPL'`,
    );
    expect(Number(rows[0]?.count)).toBe(2); // idempotent
  });
});

describe('holiday skip', () => {
  it('recognizes NYSE holidays vs trading days', async () => {
    const { isNyseHoliday } = await import('../../src/market/holidays.js');

    // 2025-01-01 is New Year's Day
    expect(isNyseHoliday(new Date('2025-01-01T21:30:00Z'))).toBe(true);
    // 2025-01-02 is a normal trading day
    expect(isNyseHoliday(new Date('2025-01-02T21:30:00Z'))).toBe(false);
  });
});
