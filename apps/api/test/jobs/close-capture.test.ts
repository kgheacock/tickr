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
import { mostRecentSessionDate } from '../../src/market/holidays.js';

pg.types.setTypeParser(20, Number); // BIGINT (close) → number

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
  await client.query(`DELETE FROM session_close`);
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

// A /quote response in dollars; the job rounds c to cents. The default frozen
// post-close price is $175.50 → 17550 cents.
function mockQuote(c = 175.5): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify({ c, o: 174, h: 177, l: 173, pc: 174 }), {
        status: 200,
      }),
    ),
  );
}

describe('close capture', () => {
  it('captures the close in cents for the playable corpus only', async () => {
    await client.query(`
      INSERT INTO universe_symbol (symbol, backfilled, removed_at, data_status)
      VALUES
        ('AAPL', true,  NULL,  NULL),
        ('MSFT', true,  NULL,  NULL),
        ('GOOG', false, NULL,  NULL),                 -- not backfilled
        ('DEAD', true,  now(), NULL),                 -- removed
        ('THIN', true,  NULL,  'incomplete')          -- depth-capped
    `);

    vi.stubGlobal('fetch', mockQuote());

    const { runCloseCapture } = await import('../../src/jobs/close-capture.js');
    await runCloseCapture(redis);

    const { rows } = await client.query<{ symbol: string; close: number }>(
      `SELECT symbol, close FROM session_close ORDER BY symbol`,
    );
    expect(rows.map((r) => r.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(rows.every((r) => r.close === 17550)).toBe(true);
  });

  it('keys the row on the most recent session date', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );
    vi.stubGlobal('fetch', mockQuote());

    const { runCloseCapture } = await import('../../src/jobs/close-capture.js');
    await runCloseCapture(redis);

    const { rows } = await client.query<{ session_date: string }>(
      `SELECT to_char(session_date, 'YYYY-MM-DD') AS session_date
         FROM session_close WHERE symbol = 'AAPL'`,
    );
    expect(rows[0]?.session_date).toBe(mostRecentSessionDate(new Date()));
  });

  it('is idempotent and refreshes the close on re-capture', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );

    const { runCloseCapture } = await import('../../src/jobs/close-capture.js');

    vi.stubGlobal('fetch', mockQuote(175.5));
    await runCloseCapture(redis);
    vi.stubGlobal('fetch', mockQuote(180.25));
    await runCloseCapture(redis);

    const { rows } = await client.query<{ count: string; close: number }>(
      `SELECT count(*) AS count, max(close) AS close FROM session_close
        WHERE symbol = 'AAPL'`,
    );
    expect(Number(rows[0]?.count)).toBe(1); // one row, not two
    expect(rows[0]?.close).toBe(18025); // refreshed to the latest close
  });

  it('skips symbols whose quote has a non-positive price (halted/unknown)', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('HALT', true)`,
    );
    vi.stubGlobal('fetch', mockQuote(0)); // Finnhub returns c:0 for unknown

    const { runCloseCapture } = await import('../../src/jobs/close-capture.js');
    await runCloseCapture(redis);

    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) AS count FROM session_close`,
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('continues the sweep when one symbol fails', async () => {
    await client.query(`
      INSERT INTO universe_symbol (symbol, backfilled)
      VALUES ('FAIL', true), ('OKAY', true)
    `);

    // FAIL throws (network), OKAY returns a normal quote. ORDER BY symbol puts
    // FAIL first, so the sweep must survive it to reach OKAY.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes('symbol=FAIL')) {
          return Promise.reject(
            Object.assign(new Error('socket hang up'), {
              cause: { code: 'ECONNRESET' },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ c: 99.99 }), { status: 200 }),
        );
      }),
    );

    const { runCloseCapture } = await import('../../src/jobs/close-capture.js');
    await runCloseCapture(redis);

    const { rows } = await client.query<{ symbol: string }>(
      `SELECT symbol FROM session_close ORDER BY symbol`,
    );
    expect(rows.map((r) => r.symbol)).toEqual(['OKAY']);
  });
});
