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

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;
let redis: Redis;

beforeAll(async () => {
  vi.stubEnv('ROLE', 'bot');

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

async function reset() {
  await client.query(`DELETE FROM fill`);
  await client.query(`DELETE FROM trade_order`);
  await client.query(`DELETE FROM position`);
  await client.query(`DELETE FROM portfolio`);
  await client.query(`DELETE FROM algo`);
  await client.query(`DELETE FROM price_bar`);
  await client.query(`DELETE FROM universe_symbol`);
  await client.query(`DELETE FROM app_user`);
  await redis.del('bot:seed-index:lock');
}

async function seedSymbols(
  symbols: string[],
  priceCents = 10_000,
): Promise<void> {
  await client.query(
    `INSERT INTO app_user (id, display_name, role)
     VALUES ($1, 'system', 'admin') ON CONFLICT (id) DO NOTHING`,
    [SYSTEM_USER_ID],
  );
  for (const sym of symbols) {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
      [sym],
    );
    await client.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ($1, now(), $2, $2, $2, $2, 1000)`,
      [sym, priceCents],
    );
  }
}

describe('seedIndexBot', () => {
  beforeEach(async () => {
    await reset();
    vi.resetModules();
  });

  it('creates one algo, one portfolio, and N fills', async () => {
    await seedSymbols(['AAPL', 'MSFT', 'GOOG']);

    const { seedIndexBot } = await import('../../src/bot/seed-index.js');
    await seedIndexBot(redis);

    const { rows: algos } = await client.query(
      `SELECT * FROM algo WHERE name = 'index' AND kind = 'house'`,
    );
    expect(algos).toHaveLength(1);

    const { rows: portfolios } = await client.query(
      `SELECT * FROM portfolio WHERE algo_id = $1`,
      [algos[0]!.id],
    );
    expect(portfolios).toHaveLength(1);
    expect(portfolios[0]!.user_id).toBe(SYSTEM_USER_ID);

    const { rows: fills } = await client.query(
      `SELECT f.* FROM fill f
       JOIN trade_order o ON o.id = f.order_id
       WHERE o.portfolio_id = $1`,
      [portfolios[0]!.id],
    );
    expect(fills).toHaveLength(3);

    // Each fill should be a buy for one of the seeded symbols.
    const filledSymbols = fills.map((f) => f.symbol).sort();
    expect(filledSymbols).toEqual(['AAPL', 'GOOG', 'MSFT']);
  });

  it('re-running is a no-op (no extra fills)', async () => {
    await seedSymbols(['AAPL', 'MSFT']);

    const { seedIndexBot } = await import('../../src/bot/seed-index.js');
    await seedIndexBot(redis);

    // Remove the Redis lock so the second call can enter.
    await redis.del('bot:seed-index:lock');
    vi.resetModules();

    const { seedIndexBot: seedIndexBot2 } = await import(
      '../../src/bot/seed-index.js'
    );
    await seedIndexBot2(redis);

    const { rows: fills } = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM fill`,
    );
    expect(Number(fills[0]!.cnt)).toBe(2);
  });

  it('defers when any symbol is not yet backfilled', async () => {
    await client.query(
      `INSERT INTO app_user (id, display_name, role)
       VALUES ($1, 'system', 'admin') ON CONFLICT (id) DO NOTHING`,
      [SYSTEM_USER_ID],
    );
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true), ('PENDING', false)`,
    );
    await client.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ('AAPL', now(), 1000, 1000, 1000, 1000, 1000)`,
    );

    const { seedIndexBot } = await import('../../src/bot/seed-index.js');
    await seedIndexBot(redis);

    const { rows: algos } = await client.query(
      `SELECT * FROM algo WHERE name = 'index'`,
    );
    expect(algos).toHaveLength(0);
  });

  it('avg_cost on position equals fill price (single price)', async () => {
    await seedSymbols(['AAPL'], 5_000);

    const { seedIndexBot } = await import('../../src/bot/seed-index.js');
    await seedIndexBot(redis);

    const { rows: positions } = await client.query<{
      avg_cost: number;
      quantity: string;
    }>(
      `SELECT pos.avg_cost, pos.quantity::text
       FROM position pos
       JOIN portfolio p ON p.id = pos.portfolio_id
       JOIN algo a ON a.id = p.algo_id
       WHERE a.name = 'index'`,
    );
    expect(positions).toHaveLength(1);
    expect(positions[0]!.avg_cost).toBe(5_000);
    // qty = floor(100_000_000 / 1 / 5_000) = 20_000 shares
    expect(parseFloat(positions[0]!.quantity)).toBeCloseTo(20_000, 4);
  });
});
