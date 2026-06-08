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

async function seedSymbol(
  symbol: string,
  backfilled: boolean,
  backfilledAt?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled, backfilled_at) VALUES ($1, $2, $3)`,
    [symbol, backfilled, backfilledAt ?? null],
  );
}
async function seedBar(
  symbol: string,
  ts: string,
  close: number,
): Promise<void> {
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close) VALUES ($1, $2, $3, $3, $3, $3)`,
    [symbol, ts, close],
  );
}

describe('loadUniverse', () => {
  it('returns coverage bounds and backfill state', async () => {
    await seedSymbol('AAPL', true, '2024-02-01T00:00:00Z');
    await seedBar('AAPL', '2024-01-02T21:00:00Z', 18000);
    await seedBar('AAPL', '2024-06-03T21:00:00Z', 19000);
    await seedSymbol('TSLA', false);

    const { loadUniverse } = await import('../../src/routes/universe.js');
    const res = await loadUniverse(false);

    const aapl = res.items.find((i) => i.symbol === 'AAPL')!;
    expect(aapl.backfilled).toBe(true);
    expect(aapl.backfilledAt).toBe('2024-02-01T00:00:00.000Z');
    expect(aapl.firstBarAt).toBe('2024-01-02T21:00:00.000Z');
    expect(aapl.lastBarAt).toBe('2024-06-03T21:00:00.000Z');

    const tsla = res.items.find((i) => i.symbol === 'TSLA')!;
    expect(tsla.backfilled).toBe(false);
    expect(tsla.firstBarAt).toBeNull();
    expect(tsla.lastBarAt).toBeNull();
  });

  it('?backfilled=true filters to backfilled symbols only', async () => {
    await seedSymbol('AAPL', true);
    await seedSymbol('TSLA', false);

    const { loadUniverse } = await import('../../src/routes/universe.js');
    const res = await loadUniverse(true);

    expect(res.items.map((i) => i.symbol)).toEqual(['AAPL']);
  });

  it('excludes removed symbols from the corpus', async () => {
    await seedSymbol('AAPL', true);
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled, removed_at) VALUES ('GONE', true, now())`,
    );

    const { loadUniverse } = await import('../../src/routes/universe.js');
    const res = await loadUniverse(false);
    expect(res.items.map((i) => i.symbol)).toEqual(['AAPL']);
  });
});
