import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';

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

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${name}`],
  );
  return rows[0]!.exists;
}

describe('platformize migration (item 16)', () => {
  it('drops the game-only tables', async () => {
    for (const t of [
      'portfolio',
      'position',
      'trade_order',
      'fill',
      'valuation_snapshot',
      'leaderboard_row',
      'algo',
    ]) {
      expect(await tableExists(t), `${t} should be dropped`).toBe(false);
    }
  });

  it('keeps the platform-core tables', async () => {
    for (const t of ['app_user', 'identity', 'universe_symbol', 'price_bar']) {
      expect(await tableExists(t), `${t} should survive`).toBe(true);
    }
  });
});

describe('universe_symbol FK on price_bar', () => {
  it('rejects a bar referencing a symbol absent from universe_symbol', async () => {
    await expect(
      client.query(
        `INSERT INTO price_bar (symbol, ts, open, high, low, close)
         VALUES ('DOESNOTEXIST', now(), 1, 1, 1, 1)`,
      ),
    ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
  });

  it('accepts a bar for a known universe_symbol', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol) VALUES ('AAPL') ON CONFLICT DO NOTHING`,
    );
    await client.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close)
       VALUES ('AAPL', now(), 18000, 18500, 17900, 18400)
       ON CONFLICT DO NOTHING`,
    );
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
