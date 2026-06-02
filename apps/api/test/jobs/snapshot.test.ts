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

// Use DB 1 to avoid key collisions with other test files sharing localhost:6379.
const REDIS_URL =
  (process.env['REDIS_URL'] ?? 'redis://localhost:6379').replace(/\/\d+$/, '') +
  '/1';

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;
let redis: Redis;

beforeAll(async () => {
  vi.stubEnv('ROLE', 'worker');

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

// Fixed UUIDs for deterministic tie-break ordering assertions.
const USER_A = '00000000-0000-0000-0000-000000000001';
const USER_B = '00000000-0000-0000-0000-000000000002';
const USER_C = '00000000-0000-0000-0000-000000000003';
const PORT_A = '00000000-0000-0000-0000-00000000aa01';
const PORT_B = '00000000-0000-0000-0000-00000000aa02';
const PORT_C = '00000000-0000-0000-0000-00000000aa03';

async function seedUser(id: string, displayName: string): Promise<void> {
  await client.query(
    `INSERT INTO app_user (id, display_name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, displayName],
  );
}

async function seedPortfolio(
  id: string,
  userId: string,
  cash: number,
): Promise<void> {
  await client.query(
    `INSERT INTO portfolio (id, user_id, cash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [id, userId, cash],
  );
}

async function seedSymbol(symbol: string): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true) ON CONFLICT DO NOTHING`,
    [symbol],
  );
}

async function seedPosition(
  portfolioId: string,
  symbol: string,
  quantity: number,
): Promise<void> {
  await client.query(
    `INSERT INTO position (portfolio_id, symbol, quantity, avg_cost)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (portfolio_id, symbol) DO UPDATE SET quantity = $3`,
    [portfolioId, symbol, quantity],
  );
}

async function seedPriceBar(
  symbol: string,
  closeCents: number,
  daysAgo = 0,
): Promise<void> {
  const ts = new Date();
  ts.setUTCDate(ts.getUTCDate() - daysAgo);
  ts.setUTCHours(21, 0, 0, 0);
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close)
     VALUES ($1, $2, $3, $3, $3, $3)
     ON CONFLICT (symbol, ts) DO UPDATE SET close = $3`,
    [symbol, ts.toISOString(), closeCents],
  );
}

beforeEach(async () => {
  await client.query(`DELETE FROM valuation_snapshot`);
  await client.query(`DELETE FROM leaderboard_row`);
  await client.query(`DELETE FROM position`);
  await client.query(`DELETE FROM price_bar`);
  await client.query(`DELETE FROM portfolio`);
  await client.query(`DELETE FROM app_user`);
  await client.query(`DELETE FROM universe_symbol`);
  await redis.del(
    'leaderboard:latest',
    'leaderboard:taken_at',
    'metric:lastSnapshotAt',
  );
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('runSnapshot', () => {
  it('computes equity = cash + Σ qty × close for 3 portfolios and 2 symbols', async () => {
    await seedUser(USER_A, 'Alice');
    await seedUser(USER_B, 'Bob');
    await seedUser(USER_C, 'Carol');

    await seedPortfolio(PORT_A, USER_A, 50_000_000); // $500k cash
    await seedPortfolio(PORT_B, USER_B, 80_000_000); // $800k cash
    await seedPortfolio(PORT_C, USER_C, 100_000_000); // $1M cash, no positions

    await seedSymbol('AAPL');
    await seedSymbol('MSFT');

    await seedPriceBar('AAPL', 20000); // $200.00
    await seedPriceBar('MSFT', 40000); // $400.00

    await seedPosition(PORT_A, 'AAPL', 100); // 100 × 200 = 20000 dollars = 2_000_000 cents
    await seedPosition(PORT_A, 'MSFT', 50); // 50 × 400 = 20000 dollars = 2_000_000 cents
    // PORT_A equity = 50_000_000 + 2_000_000 + 2_000_000 = 54_000_000

    await seedPosition(PORT_B, 'AAPL', 10); // 10 × 200 = 200_000 cents
    // PORT_B equity = 80_000_000 + 200_000 = 80_200_000

    // PORT_C: no positions
    // PORT_C equity = 100_000_000

    const { runSnapshot } = await import('../../src/jobs/snapshot.js');
    await runSnapshot(redis);

    const { rows } = await client.query<{
      portfolio_id: string;
      cash: number;
      positions_value: number;
      equity: number;
    }>(
      `SELECT portfolio_id, cash, positions_value, equity
       FROM valuation_snapshot
       ORDER BY portfolio_id`,
    );

    expect(rows).toHaveLength(3);

    const byId = Object.fromEntries(rows.map((r) => [r.portfolio_id, r]));

    expect(byId[PORT_A]!.equity).toBe(54_000_000);
    expect(byId[PORT_A]!.positions_value).toBe(4_000_000);
    expect(byId[PORT_A]!.cash).toBe(50_000_000);

    expect(byId[PORT_B]!.equity).toBe(80_200_000);
    expect(byId[PORT_B]!.positions_value).toBe(200_000);

    expect(byId[PORT_C]!.equity).toBe(100_000_000);
    expect(byId[PORT_C]!.positions_value).toBe(0);
  });

  it('is idempotent — re-running for the same taken_at inserts no new rows', async () => {
    await seedUser(USER_A, 'Alice');
    await seedPortfolio(PORT_A, USER_A, 100_000_000);
    await seedSymbol('AAPL');
    await seedPriceBar('AAPL', 15000);

    const { runSnapshot } = await import('../../src/jobs/snapshot.js');
    await runSnapshot(redis);
    await runSnapshot(redis);

    const { rows: snapRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM valuation_snapshot`,
    );
    expect(Number(snapRows[0]?.count)).toBe(1);

    const { rows: lbRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM leaderboard_row`,
    );
    expect(Number(lbRows[0]?.count)).toBe(1);
  });

  it('ties share the same rank; secondary sort by portfolio_id breaks display order', async () => {
    await seedUser(USER_A, 'Alice');
    await seedUser(USER_B, 'Bob');

    // Both portfolios start with same cash, no positions → same equity → tied.
    await seedPortfolio(PORT_A, USER_A, 100_000_000);
    await seedPortfolio(PORT_B, USER_B, 100_000_000);

    const { runSnapshot } = await import('../../src/jobs/snapshot.js');
    await runSnapshot(redis);

    const { rows } = await client.query<{
      portfolio_id: string;
      rank: number;
    }>(
      `SELECT portfolio_id, rank
       FROM leaderboard_row
       ORDER BY rank, portfolio_id`,
    );

    expect(rows).toHaveLength(2);
    // Both tied at rank 1.
    expect(rows[0]!.rank).toBe(1);
    expect(rows[1]!.rank).toBe(1);
    // Deterministic order by portfolio_id UUID.
    expect(rows[0]!.portfolio_id < rows[1]!.portfolio_id).toBe(true);
  });

  it('sets metric:lastSnapshotAt in Redis', async () => {
    await seedUser(USER_A, 'Alice');
    await seedPortfolio(PORT_A, USER_A, 100_000_000);

    const { runSnapshot, snapshotTakenAt } =
      await import('../../src/jobs/snapshot.js');
    await runSnapshot(redis);

    const val = await redis.get('metric:lastSnapshotAt');
    expect(val).toBe(snapshotTakenAt().toISOString());
  });
});
