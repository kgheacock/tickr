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
  await client.query(`DELETE FROM etf`);
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
  close: number,
): Promise<void> {
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close) VALUES ($1, $2, $3, $3, $3, $3)`,
    [symbol, ts, close],
  );
}

describe('SMA-crossover wiring (orders → /evaluate)', () => {
  it('replays every generated order without a rejection', async () => {
    // Single-member ETF: synthetic close == member close, so the SMA orders
    // land exactly on bars the replay engine can fill (no STALE/rejection).
    await seedSymbol('AAA');
    const closes = [
      10000, 10000, 10000, 20000, 20000, 20000, 10000, 10000, 10000,
    ];
    for (let i = 0; i < closes.length; i++) {
      const day = String(i + 1).padStart(2, '0');
      await seedBar('AAA', `2024-01-${day}T21:00:00Z`, closes[i]!);
    }
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO etf (key, name, base_date) VALUES ('solo', 'Solo', '2024-01-01') RETURNING id`,
    );
    await client.query(
      `INSERT INTO etf_weight (etf_id, symbol, weight) VALUES ($1, 'AAA', 1)`,
      [rows[0]!.id],
    );

    const { etfSeries } = await import('../../src/etf/series.js');
    const { runSmaCrossover } =
      await import('../../src/strategy/sma-crossover.js');
    const { replay } = await import('../../src/eval/replay.js');

    const series = await etfSeries(pool, 'solo', {
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-31T00:00:00Z',
    });
    const daily = series.map((b) => ({ ts: b.ts, close: b.close }));
    const startingCash = 1_000_000;
    const { orders } = runSmaCrossover(daily, 'etf:solo', startingCash, {
      shortWindow: 2,
      longWindow: 3,
    });

    expect(orders.length).toBeGreaterThan(0);

    const evaluated = await replay({ startingCash, orders });
    expect(evaluated.orders.every((o) => o.status === 'filled')).toBe(true);
    // Round trip: bought @20000, sold @10000 → half the cash remains.
    expect(evaluated.finalEquity).toBe(500_000);
  });
});

describe('seedSp500', () => {
  it('seeds an equal-weight ETF over backfilled symbols and refreshes idempotently', async () => {
    await seedSymbol('AAA');
    await seedSymbol('BBB');
    await seedBar('AAA', '2024-01-01T21:00:00Z', 10000);
    await seedBar('BBB', '2024-02-01T21:00:00Z', 20000); // later first bar

    const { seedSp500 } = await import('../../src/bootstrap/seed-sp500.js');
    await seedSp500();

    const first = await client.query<{
      base_date: string;
      member_count: string;
    }>(
      `SELECT e.base_date::text AS base_date, COUNT(w.symbol)::text AS member_count
         FROM etf e JOIN etf_weight w ON w.etf_id = e.id
        WHERE e.key = 'sp500' GROUP BY e.base_date`,
    );
    expect(first.rows[0]!.member_count).toBe('2');
    // base_date is the latest first-bar date so every member has a bar by then.
    expect(first.rows[0]!.base_date).toBe('2024-02-01');

    // Add a third backfilled member and re-seed: weights fully replaced.
    await seedSymbol('CCC');
    await seedBar('CCC', '2024-01-15T21:00:00Z', 5000);
    await seedSp500();

    const second = await client.query<{ member_count: string }>(
      `SELECT COUNT(w.symbol)::text AS member_count
         FROM etf e JOIN etf_weight w ON w.etf_id = e.id
        WHERE e.key = 'sp500'`,
    );
    expect(second.rows[0]!.member_count).toBe('3');
  });

  it('skips gracefully when nothing is backfilled', async () => {
    const { seedSp500 } = await import('../../src/bootstrap/seed-sp500.js');
    await expect(seedSp500()).resolves.toBeUndefined();
    const { rows } = await client.query(
      `SELECT 1 FROM etf WHERE key = 'sp500'`,
    );
    expect(rows).toHaveLength(0);
  });
});
