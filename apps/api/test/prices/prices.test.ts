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
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
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
}, 120_000);

afterAll(async () => {
  await client?.end();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await client.query(`DELETE FROM price_bar`);
  await client.query(`DELETE FROM universe_symbol`);
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

async function seedSymbol(symbol: string): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true) ON CONFLICT DO NOTHING`,
    [symbol],
  );
}
async function seedBar(
  symbol: string,
  ts: string,
  ohlc: number,
  volume: number | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $3, $3, $3, $4)`,
    [symbol, ts, ohlc, volume],
  );
}

describe('loadPrices', () => {
  it('returns bars within the window and routes unknown symbols to missing', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-03-01T21:00:00Z', 18000, 1000);
    await seedBar('AAPL', '2024-03-02T21:00:00Z', 18500);

    const { loadPrices } = await import('../../src/routes/prices.js');
    const res = await loadPrices({
      symbols: ['AAPL', 'NOPE'],
      from: '2024-01-01',
      to: '2024-06-01',
    });

    expect(res.series['AAPL']).toHaveLength(2);
    expect(res.series['AAPL']![0]).toMatchObject({
      close: 18000,
      volume: 1000,
    });
    expect(res.series['AAPL']![1]).toMatchObject({
      close: 18500,
      volume: null,
    });
    expect(res.missing).toContain('NOPE');
  });

  it('puts known-but-no-bars-in-window symbols in missing', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2020-01-02T21:00:00Z', 10000); // outside window

    const { loadPrices } = await import('../../src/routes/prices.js');
    const res = await loadPrices({
      symbols: ['AAPL'],
      from: '2024-01-01',
      to: '2024-06-01',
    });

    expect(res.series['AAPL']).toBeUndefined();
    expect(res.missing).toEqual(['AAPL']);
  });

  it('clamps the resolved window to the 2-year cap', async () => {
    const { loadPrices, MAX_WINDOW_DAYS } =
      await import('../../src/routes/prices.js');
    const res = await loadPrices({
      symbols: ['AAPL'],
      from: '2000-01-01T00:00:00Z',
      to: '2024-01-01T00:00:00Z',
    });

    const windowMs = Date.parse(res.to) - Date.parse(res.from);
    expect(windowMs).toBeLessThanOrEqual(MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  });

  it('throws RangeError above the symbol cap', async () => {
    const { loadPrices, MAX_PRICE_SYMBOLS } =
      await import('../../src/routes/prices.js');
    const symbols = Array.from(
      { length: MAX_PRICE_SYMBOLS + 1 },
      (_, i) => `SYM${i}`,
    );
    await expect(loadPrices({ symbols })).rejects.toBeInstanceOf(RangeError);
  });

  it('throws RangeError on an invalid date', async () => {
    const { loadPrices } = await import('../../src/routes/prices.js');
    await expect(
      loadPrices({ symbols: ['AAPL'], from: 'not-a-date' }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
