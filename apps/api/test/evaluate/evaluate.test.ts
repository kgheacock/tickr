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
  close: number,
): Promise<void> {
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close) VALUES ($1, $2, $3, $3, $3, $3)`,
    [symbol, ts, close],
  );
}

describe('replay (stateless evaluator)', () => {
  it('fills at the point-in-time close, not the latest', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('AAPL', '2024-01-10T21:00:00Z', 20000);

    const { replay } = await import('../../src/eval/replay.js');
    const res = await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'AAPL',
          side: 'buy',
          quantity: 1,
          at: '2024-01-05T12:00:00Z',
        },
      ],
    });

    // The 01-01 bar (10000), not the later 01-10 bar (20000).
    expect(res.orders[0]!.status).toBe('filled');
    expect(res.orders[0]!.fillPrice).toBe(10000);
  });

  it('computes totalReturnPct for a known buy/sell pair', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('AAPL', '2024-01-10T21:00:00Z', 20000);

    const { replay } = await import('../../src/eval/replay.js');
    const res = await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'AAPL',
          side: 'buy',
          quantity: 10,
          at: '2024-01-02T12:00:00Z',
        },
        {
          symbol: 'AAPL',
          side: 'sell',
          quantity: 10,
          at: '2024-01-11T12:00:00Z',
        },
      ],
    });

    expect(res.finalCash).toBe(1_100_000);
    expect(res.finalPositions).toEqual([]);
    expect(res.finalEquity).toBe(1_100_000);
    expect(res.totalReturnPct).toBeCloseTo(10, 6);
  });

  it('rejects SYMBOL_NOT_TRADEABLE when no bar exists at or before `at`', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-02-01T21:00:00Z', 10000);

    const { replay } = await import('../../src/eval/replay.js');
    const res = await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'AAPL',
          side: 'buy',
          quantity: 1,
          at: '2024-01-01T12:00:00Z',
        },
      ],
    });

    expect(res.orders[0]!.status).toBe('rejected');
    expect(res.orders[0]!.rejectReason).toBe('SYMBOL_NOT_TRADEABLE');
    expect(res.orders[0]!.fillPrice).toBeNull();
  });

  it('rejects STALE_PRICE when the nearest prior bar is older than 5 days', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);

    const { replay } = await import('../../src/eval/replay.js');
    const res = await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'AAPL',
          side: 'buy',
          quantity: 1,
          at: '2024-01-20T12:00:00Z',
        },
      ],
    });

    expect(res.orders[0]!.rejectReason).toBe('STALE_PRICE');
  });

  it('rejects INSUFFICIENT_FUNDS and INSUFFICIENT_POSITION', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);

    const { replay } = await import('../../src/eval/replay.js');

    const funds = await replay({
      startingCash: 100, // 1 dollar
      orders: [
        {
          symbol: 'AAPL',
          side: 'buy',
          quantity: 10,
          at: '2024-01-02T12:00:00Z',
        },
      ],
    });
    expect(funds.orders[0]!.rejectReason).toBe('INSUFFICIENT_FUNDS');

    const position = await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'AAPL',
          side: 'sell',
          quantity: 5,
          at: '2024-01-02T12:00:00Z',
        },
      ],
    });
    expect(position.orders[0]!.rejectReason).toBe('INSUFFICIENT_POSITION');
  });

  it('writes nothing to the database', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);

    const before = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar`,
    );

    const { replay } = await import('../../src/eval/replay.js');
    await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'AAPL',
          side: 'buy',
          quantity: 1,
          at: '2024-01-02T12:00:00Z',
        },
      ],
    });

    const after = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar`,
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });
});
