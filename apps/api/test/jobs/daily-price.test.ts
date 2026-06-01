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
  vi.stubEnv('FINNHUB_API_KEY', process.env['FINNHUB_API_KEY'] ?? 'test-key');

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

vi.mock('../../src/finnhub/bucket.js', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  BUCKET_KEY: 'finnhub:bucket',
}));

const QUOTE = { c: 175.5, h: 177.0, l: 174.0, o: 175.0, pc: 174.5 };

function mockFetchQuote() {
  return vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(QUOTE), { status: 200 })),
    );
}

describe('daily-price', () => {
  it('inserts one row per backfilled symbol', async () => {
    await client.query(`
      INSERT INTO universe_symbol (symbol, backfilled)
      VALUES ('AAPL', true), ('MSFT', true), ('GOOG', false)
    `);

    vi.stubGlobal('fetch', mockFetchQuote());

    const { runDailyPrice } = await import('../../src/jobs/daily-price.js');
    await runDailyPrice(redis);

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar`,
    );
    expect(Number(rows[0]?.count)).toBe(2); // GOOG (not backfilled) excluded
  });

  it('stores prices as cents and volume as NULL', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );

    vi.stubGlobal('fetch', mockFetchQuote());

    const { runDailyPrice } = await import('../../src/jobs/daily-price.js');
    await runDailyPrice(redis);

    const { rows } = await client.query<{
      open: number;
      high: number;
      low: number;
      close: number;
      volume: string | null;
    }>(
      `SELECT open, high, low, close, volume FROM price_bar WHERE symbol = 'AAPL'`,
    );

    expect(rows[0]?.open).toBe(17500); // 175.00 × 100
    expect(rows[0]?.high).toBe(17700); // 177.00 × 100
    expect(rows[0]?.low).toBe(17400); // 174.00 × 100
    expect(rows[0]?.close).toBe(17550); // 175.50 × 100
    expect(rows[0]?.volume).toBeNull();
  });

  it('running twice inserts zero new rows the second time (ON CONFLICT)', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );

    const mockFetch = mockFetchQuote();
    vi.stubGlobal('fetch', mockFetch);

    const { runDailyPrice } = await import('../../src/jobs/daily-price.js');
    await runDailyPrice(redis);
    await runDailyPrice(redis);

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'AAPL'`,
    );
    expect(Number(rows[0]?.count)).toBe(1); // idempotent
  });

  it('marketCloseTs is deterministic for the same calendar day', async () => {
    const { marketCloseTs } = await import('../../src/jobs/daily-price.js');

    const t1 = marketCloseTs(new Date('2025-06-10T21:05:00Z'));
    const t2 = marketCloseTs(new Date('2025-06-10T21:59:59Z'));
    expect(t1.toISOString()).toBe(t2.toISOString());
    expect(t1.toISOString()).toBe('2025-06-10T21:00:00.000Z');
  });
});

describe('holiday skip', () => {
  it('skips daily price update on NYSE holidays', async () => {
    const { isNyseHoliday } = await import('../../src/market/holidays.js');

    // 2025-01-01 is New Year's Day
    expect(isNyseHoliday(new Date('2025-01-01T21:30:00Z'))).toBe(true);
    // 2025-01-02 is a normal trading day
    expect(isNyseHoliday(new Date('2025-01-02T21:30:00Z'))).toBe(false);
  });
});
