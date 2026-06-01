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
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  vi.stubEnv('ROLE', 'api');

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
  vi.unstubAllGlobals();
  await client?.end();
  await pool?.end();
  await container?.stop();
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

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

async function seed({
  cash = 100_000_00,
  backfilled = true,
  priceCents = 1000,
  priceDaysAgo = 0,
}: {
  cash?: number;
  backfilled?: boolean;
  priceCents?: number;
  priceDaysAgo?: number;
} = {}) {
  await client.query(`DELETE FROM fill`);
  await client.query(`DELETE FROM trade_order`);
  await client.query(`DELETE FROM position`);
  await client.query(`DELETE FROM portfolio`);
  await client.query(`DELETE FROM algo`);
  await client.query(`DELETE FROM price_bar`);
  await client.query(`DELETE FROM universe_symbol`);
  await client.query(`DELETE FROM app_user`);

  const userId = randomUUID();
  const portfolioId = randomUUID();

  await client.query(
    `INSERT INTO app_user (id, display_name, role) VALUES ($1, 'Tester', 'player')`,
    [userId],
  );
  await client.query(
    `INSERT INTO portfolio (id, user_id, cash) VALUES ($1, $2, $3)`,
    [portfolioId, userId, cash],
  );
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('TEST', $1)`,
    [backfilled],
  );

  if (priceCents > 0) {
    const priceTs = new Date(Date.now() - priceDaysAgo * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ('TEST', $1, $2, $2, $2, $2, 1000)`,
      [priceTs.toISOString(), priceCents],
    );
  }

  return { userId, portfolioId };
}

describe('executeTrade', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('buy reduces cash and creates position', async () => {
    const { portfolioId } = await seed({ cash: 10_000, priceCents: 1000 });
    const { executeTrade } = await import('../../src/trading/execute.js');

    const result = await executeTrade({
      portfolioId,
      symbol: 'TEST',
      side: 'buy',
      quantity: 5,
      idempotencyKey: 'k1',
      source: 'human',
    });

    expect(result.order.status).toBe('filled');
    expect(result.fill.price).toBe(1000);
    expect(result.fill.quantity).toBeCloseTo(5);

    const { rows: portRows } = await client.query<{ cash: number }>(
      `SELECT cash FROM portfolio WHERE id = $1`,
      [portfolioId],
    );
    expect(portRows[0]!.cash).toBe(10_000 - 5 * 1000);

    const { rows: posRows } = await client.query<{ quantity: string; avg_cost: number }>(
      `SELECT quantity, avg_cost FROM position WHERE portfolio_id = $1 AND symbol = 'TEST'`,
      [portfolioId],
    );
    expect(parseFloat(posRows[0]!.quantity)).toBeCloseTo(5);
    expect(posRows[0]!.avg_cost).toBe(1000);
  });

  it('second buy at different price computes weighted avg_cost', async () => {
    const { portfolioId } = await seed({ cash: 100_000, priceCents: 1000 });
    vi.resetModules();
    const { executeTrade } = await import('../../src/trading/execute.js');

    await executeTrade({
      portfolioId,
      symbol: 'TEST',
      side: 'buy',
      quantity: 10,
      idempotencyKey: 'k1',
      source: 'human',
    });

    // Update price bar to a higher price for the second buy.
    await client.query(
      `UPDATE price_bar SET close = 2000 WHERE symbol = 'TEST'`,
    );

    vi.resetModules();
    const { executeTrade: executeTrade2 } = await import(
      '../../src/trading/execute.js'
    );
    await executeTrade2({
      portfolioId,
      symbol: 'TEST',
      side: 'buy',
      quantity: 10,
      idempotencyKey: 'k2',
      source: 'human',
    });

    const { rows } = await client.query<{
      quantity: string;
      avg_cost: number;
    }>(
      `SELECT quantity, avg_cost FROM position WHERE portfolio_id = $1 AND symbol = 'TEST'`,
      [portfolioId],
    );
    expect(parseFloat(rows[0]!.quantity)).toBeCloseTo(20);
    // Weighted avg: (10×1000 + 10×2000) / 20 = 1500
    expect(rows[0]!.avg_cost).toBeCloseTo(1500, 0);
  });

  it('sell of full holding deletes the position row', async () => {
    const { portfolioId } = await seed({ cash: 10_000, priceCents: 1000 });
    vi.resetModules();
    const { executeTrade } = await import('../../src/trading/execute.js');

    await executeTrade({
      portfolioId,
      symbol: 'TEST',
      side: 'buy',
      quantity: 5,
      idempotencyKey: 'buy1',
      source: 'human',
    });

    vi.resetModules();
    const { executeTrade: executeSell } = await import(
      '../../src/trading/execute.js'
    );
    await executeSell({
      portfolioId,
      symbol: 'TEST',
      side: 'sell',
      quantity: 5,
      idempotencyKey: 'sell1',
      source: 'human',
    });

    const { rows } = await client.query(
      `SELECT * FROM position WHERE portfolio_id = $1 AND symbol = 'TEST'`,
      [portfolioId],
    );
    expect(rows).toHaveLength(0);

    const { rows: portRows } = await client.query<{ cash: number }>(
      `SELECT cash FROM portfolio WHERE id = $1`,
      [portfolioId],
    );
    expect(portRows[0]!.cash).toBe(10_000);
  });

  it('duplicate idempotency key returns prior result with no double fill', async () => {
    const { portfolioId } = await seed({ cash: 10_000, priceCents: 1000 });
    vi.resetModules();
    const { executeTrade } = await import('../../src/trading/execute.js');

    const first = await executeTrade({
      portfolioId,
      symbol: 'TEST',
      side: 'buy',
      quantity: 1,
      idempotencyKey: 'idem1',
      source: 'human',
    });

    vi.resetModules();
    const { executeTrade: executeTrade2 } = await import(
      '../../src/trading/execute.js'
    );
    const second = await executeTrade2({
      portfolioId,
      symbol: 'TEST',
      side: 'buy',
      quantity: 1,
      idempotencyKey: 'idem1',
      source: 'human',
    });

    expect(second.order.id).toBe(first.order.id);
    expect(second.fill.id).toBe(first.fill.id);

    const { rows } = await client.query(
      `SELECT COUNT(*) AS cnt FROM fill WHERE order_id = $1`,
      [first.order.id],
    );
    expect(Number(rows[0]!.cnt)).toBe(1);

    const { rows: portRows } = await client.query<{ cash: number }>(
      `SELECT cash FROM portfolio WHERE id = $1`,
      [portfolioId],
    );
    expect(portRows[0]!.cash).toBe(10_000 - 1000);
  });

  it('concurrent buys serialize: only one succeeds when cash is exact', async () => {
    // Portfolio has exactly 1000 cents — enough for 1 share at 1000 cents.
    const { portfolioId } = await seed({ cash: 1000, priceCents: 1000 });
    vi.resetModules();
    const { executeTrade } = await import('../../src/trading/execute.js');
    const { TradeRejectionError } = await import(
      '../../src/trading/execute.js'
    );

    const results = await Promise.allSettled([
      executeTrade({
        portfolioId,
        symbol: 'TEST',
        side: 'buy',
        quantity: 1,
        idempotencyKey: 'c1',
        source: 'human',
      }),
      executeTrade({
        portfolioId,
        symbol: 'TEST',
        side: 'buy',
        quantity: 1,
        idempotencyKey: 'c2',
        source: 'human',
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      TradeRejectionError,
    );
    expect(
      ((rejected[0] as PromiseRejectedResult).reason as InstanceType<typeof TradeRejectionError>).code,
    ).toBe('INSUFFICIENT_FUNDS');

    const { rows: portRows } = await client.query<{ cash: number }>(
      `SELECT cash FROM portfolio WHERE id = $1`,
      [portfolioId],
    );
    expect(portRows[0]!.cash).toBe(0);
  });

  it('rejects SYMBOL_NOT_TRADEABLE when backfilled=false', async () => {
    const { portfolioId } = await seed({ backfilled: false });
    vi.resetModules();
    const { executeTrade, TradeRejectionError } = await import(
      '../../src/trading/execute.js'
    );

    await expect(
      executeTrade({
        portfolioId,
        symbol: 'TEST',
        side: 'buy',
        quantity: 1,
        idempotencyKey: 'k1',
        source: 'human',
      }),
    ).rejects.toMatchObject({ code: 'SYMBOL_NOT_TRADEABLE' });
    expect(true).toBe(true); // suppresses unused import warning
    void TradeRejectionError;
  });

  it('rejects STALE_PRICE when latest bar is > 5 days old', async () => {
    const { portfolioId } = await seed({
      cash: 100_000,
      priceCents: 1000,
      priceDaysAgo: 6,
    });
    vi.resetModules();
    const { executeTrade } = await import('../../src/trading/execute.js');

    await expect(
      executeTrade({
        portfolioId,
        symbol: 'TEST',
        side: 'buy',
        quantity: 1,
        idempotencyKey: 'k1',
        source: 'human',
      }),
    ).rejects.toMatchObject({ code: 'STALE_PRICE' });
  });

  it('rejects INSUFFICIENT_FUNDS when cash < cost', async () => {
    const { portfolioId } = await seed({ cash: 500, priceCents: 1000 });
    vi.resetModules();
    const { executeTrade } = await import('../../src/trading/execute.js');

    await expect(
      executeTrade({
        portfolioId,
        symbol: 'TEST',
        side: 'buy',
        quantity: 1,
        idempotencyKey: 'k1',
        source: 'human',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
  });

  it('rejects INSUFFICIENT_POSITION on sell when not holding', async () => {
    const { portfolioId } = await seed({ cash: 10_000, priceCents: 1000 });
    vi.resetModules();
    const { executeTrade } = await import('../../src/trading/execute.js');

    await expect(
      executeTrade({
        portfolioId,
        symbol: 'TEST',
        side: 'sell',
        quantity: 1,
        idempotencyKey: 'k1',
        source: 'human',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_POSITION' });
  });
});
