import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// OID 20 = int8/BIGINT — parse as number, consistent with pool.ts.
pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;

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
}, 120_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

// Helper: insert a minimal app_user and return its id.
async function insertUser(): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO app_user (id, display_name, role) VALUES ($1, $2, 'player')`,
    [id, `User-${id.slice(0, 8)}`],
  );
  return id;
}

// Helper: insert a human portfolio (algo_id = NULL) and return its id.
async function insertHumanPortfolio(userId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO portfolio (id, user_id, algo_id, cash) VALUES ($1, $2, NULL, 100000000)`,
    [id, userId],
  );
  return id;
}

describe('portfolio_one_human_per_user partial unique index', () => {
  it('allows a single human portfolio (algo_id IS NULL) per user', async () => {
    const userId = await insertUser();
    await insertHumanPortfolio(userId); // must not throw
  });

  it('rejects a second human portfolio for the same user', async () => {
    const userId = await insertUser();
    await insertHumanPortfolio(userId);

    const secondId = randomUUID();
    await expect(
      client.query(
        `INSERT INTO portfolio (id, user_id, algo_id, cash) VALUES ($1, $2, NULL, 100000000)`,
        [secondId, userId],
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });
});

describe('universe_symbol FK on position', () => {
  it('rejects a position referencing a symbol absent from universe_symbol', async () => {
    const userId = await insertUser();
    const portfolioId = await insertHumanPortfolio(userId);

    await expect(
      client.query(
        `INSERT INTO position (portfolio_id, symbol, quantity, avg_cost)
         VALUES ($1, 'DOESNOTEXIST', 1.0, 100)`,
        [portfolioId],
      ),
    ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
  });

  it('accepts a position for a known universe_symbol', async () => {
    const userId = await insertUser();
    const portfolioId = await insertHumanPortfolio(userId);

    // Seed a known symbol first.
    await client.query(
      `INSERT INTO universe_symbol (symbol) VALUES ('AAPL') ON CONFLICT DO NOTHING`,
    );

    await client.query(
      `INSERT INTO position (portfolio_id, symbol, quantity, avg_cost)
       VALUES ($1, 'AAPL', '10.00000000', 18500)`,
      [portfolioId],
    );
  });
});

describe('trade_order FK on universe_symbol', () => {
  it('rejects an order for an unknown symbol', async () => {
    const userId = await insertUser();
    const portfolioId = await insertHumanPortfolio(userId);

    await expect(
      client.query(
        `INSERT INTO trade_order
           (id, portfolio_id, symbol, side, type, quantity, status, idempotency_key, source)
         VALUES ($1, $2, 'UNKNOWN', 'buy', 'market', 1.0, 'accepted', $3, 'human')`,
        [randomUUID(), portfolioId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('price_bar hypertable', () => {
  it('is listed as a TimescaleDB hypertable', async () => {
    const result = await client.query<{ hypertable_name: string }>(
      `SELECT hypertable_name
       FROM timescaledb_information.hypertables
       WHERE hypertable_name = 'price_bar'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.hypertable_name).toBe('price_bar');
  });
});
