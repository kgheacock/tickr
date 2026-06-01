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

// Replace the pool module with one pointed at the test container.
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

// Mock the bucket so backfill tests are not rate-limited.
vi.mock('../../src/finnhub/bucket.js', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  BUCKET_KEY: 'finnhub:bucket',
}));

function makeCandles(count: number, startUnixSec: number) {
  return {
    s: 'ok' as const,
    t: Array.from({ length: count }, (_, i) => startUnixSec + i * 300),
    o: Array.from({ length: count }, () => 150.0),
    h: Array.from({ length: count }, () => 152.0),
    l: Array.from({ length: count }, () => 149.0),
    c: Array.from({ length: count }, () => 151.0),
    v: Array.from({ length: count }, () => 1000),
  };
}

describe('backfill', () => {
  it('skips symbols that are already backfilled', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );

    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ s: 'no_data' }), { status: 200 }),
      );

    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('marks symbol backfilled=true after all windows complete', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('MSFT', false)`,
    );

    // Respond ok for first window, no_data for the rest.
    const candles = makeCandles(
      5,
      Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000),
    );
    let firstCall = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(JSON.stringify(candles), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ s: 'no_data' }), { status: 200 }),
      );
    });

    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'MSFT'`,
    );
    expect(rows[0]?.backfilled).toBe(true);
  });

  it('crash mid-symbol: restart resumes and partial rows survive (ON CONFLICT)', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('GOOG', false)`,
    );

    // First run: insert 3 bars, then "crash" (mock throws after first window).
    const startSec = Math.floor((Date.now() - 60 * 24 * 60 * 60 * 1000) / 1000);
    const candles = makeCandles(3, startSec);

    let firstCall = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(JSON.stringify(candles), { status: 200 }),
        );
      }
      return Promise.reject(new Error('simulated crash'));
    });

    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await expect(runBackfill(redis)).rejects.toThrow('simulated crash');

    // Symbol still not backfilled.
    const { rows: beforeRows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'GOOG'`,
    );
    expect(beforeRows[0]?.backfilled).toBe(false);

    // Partial rows were written.
    const { rows: barRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'GOOG'`,
    );
    expect(Number(barRows[0]?.count)).toBe(3);

    // Second run (restart): re-processes but ON CONFLICT keeps row count the same.
    vi.resetModules();
    let secondFirst = true;
    const mockFetch2 = vi.fn().mockImplementation(() => {
      if (secondFirst) {
        secondFirst = false;
        return Promise.resolve(
          new Response(JSON.stringify(candles), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ s: 'no_data' }), { status: 200 }),
      );
    });
    vi.stubGlobal('fetch', mockFetch2);

    const { runBackfill: runBackfill2 } =
      await import('../../src/jobs/backfill.js');
    await runBackfill2(redis);

    const { rows: afterRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'GOOG'`,
    );
    expect(Number(afterRows[0]?.count)).toBe(3); // no duplicates

    const { rows: finalRows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'GOOG'`,
    );
    expect(finalRows[0]?.backfilled).toBe(true);
  });
});
