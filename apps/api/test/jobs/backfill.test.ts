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

function makeBars(count: number, startMs: number) {
  return {
    status: 'OK',
    ticker: 'TEST',
    queryCount: count,
    resultsCount: count,
    results: Array.from({ length: count }, (_, i) => ({
      t: startMs + i * 24 * 60 * 60 * 1000,
      o: 150.0,
      h: 152.0,
      l: 149.0,
      c: 151.0,
      v: 1000,
    })),
  };
}

function makeEmpty() {
  return {
    status: 'OK',
    ticker: 'TEST',
    queryCount: 0,
    resultsCount: 0,
    results: [],
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
        new Response(JSON.stringify(makeEmpty()), { status: 200 }),
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

    const bars = makeBars(5, Date.now() - 90 * 24 * 60 * 60 * 1000);
    let firstCall = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(JSON.stringify(bars), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(makeEmpty()), { status: 200 }),
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

    const startMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const bars = makeBars(3, startMs);

    let firstCall = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(JSON.stringify(bars), { status: 200 }),
        );
      }
      return Promise.reject(new Error('simulated crash'));
    });

    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    // A mid-symbol failure no longer aborts the whole run: the error is caught
    // per-symbol and the symbol is deferred (left backfilled = false) so the
    // next run retries it. The run itself resolves.
    await runBackfill(redis);

    const { rows: beforeRows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'GOOG'`,
    );
    expect(beforeRows[0]?.backfilled).toBe(false);

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
          new Response(JSON.stringify(bars), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(makeEmpty()), { status: 200 }),
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

describe('widen-history (script-only re-arm)', () => {
  async function seedBar(symbol: string, oldestIso: string): Promise<void> {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
      [symbol],
    );
    await client.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ($1, $2, 15000, 15200, 14900, 15100, 1000)`,
      [symbol, oldestIso],
    );
  }

  it('re-arms a backfilled symbol whose history starts after the requested date', async () => {
    await seedBar('IPO', '2022-01-03T00:00:00Z');

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2015-01-01T00:00:00Z'),
    );

    expect(reset).toBe(1);
    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'IPO'`,
    );
    expect(rows[0]?.backfilled).toBe(false);
  });

  it('leaves a symbol covered to the requested date (within tolerance) alone', async () => {
    // Earliest bar is 4 days after the requested start — a weekend/holiday gap,
    // not missing history — so it stays backfilled.
    await seedBar('FULL', '2015-01-05T00:00:00Z');

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2015-01-01T00:00:00Z'),
    );

    expect(reset).toBe(0);
    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'FULL'`,
    );
    expect(rows[0]?.backfilled).toBe(true);
  });

  it('does not touch symbols that are not yet backfilled', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('PENDING', false)`,
    );

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2015-01-01T00:00:00Z'),
    );

    expect(reset).toBe(0);
  });
});
