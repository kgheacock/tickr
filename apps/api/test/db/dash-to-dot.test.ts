import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

// Everything sorting before the dash→dot rename is "the schema as it stood
// before the rename". Target the rename migration explicitly by name rather than
// assuming it sorts last — later migrations (FS 012+, the coverage watermark)
// must not shift which step we treat as the rename.
const RENAME_MIGRATION = '1700000000011_universe-dash-to-dot.sql';
const allMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const beforeRenameCount = allMigrations.indexOf(RENAME_MIGRATION);

let container: StartedPostgreSqlContainer;
let client: pg.Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();
  const databaseUrl = container.getConnectionUri();

  // Apply every migration EXCEPT the rename, so we can seed dashed data the way
  // an existing prod DB holds it.
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: beforeRenameCount,
    verbose: false,
  });

  client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  // Seed BRK-B as a fully-wired member: the parent row (with non-default fields
  // we expect the rename to preserve) plus one row in every FK child —
  // including the ON DELETE CASCADE children, whose loss would be silent.
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled, data_status)
     VALUES ('BRK-B', true, 'ok')`,
  );
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
     VALUES ('BRK-B', '2024-06-10T14:00:00Z', 100, 110, 90, 105, 1000)`,
  );
  await client.query(
    `INSERT INTO etf (id, key, name, base_date)
     VALUES ('11111111-1111-1111-1111-111111111111', 'test', 'Test', '2024-01-01')`,
  );
  await client.query(
    `INSERT INTO etf_weight (etf_id, symbol, weight)
     VALUES ('11111111-1111-1111-1111-111111111111', 'BRK-B', 1)`,
  );
  await client.query(
    `INSERT INTO symbol_metadata (symbol, massive_ticker, name)
     VALUES ('BRK-B', 'BRK.B', 'Berkshire Hathaway')`,
  );
  await client.query(
    `INSERT INTO symbol_branding (symbol, logo_content_type)
     VALUES ('BRK-B', 'image/svg+xml')`,
  );

  // Now apply exactly the rename migration (011) — not the migrations after it,
  // which are unrelated to what this test exercises.
  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: 1,
    verbose: false,
  });
}, 120_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

async function count(table: string, symbol: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]!.n;
}

describe('migration 011 — dash→dot rename', () => {
  it('moves the parent row to the dotted key, preserving its columns', async () => {
    const { rows } = await client.query<{
      backfilled: boolean;
      data_status: string | null;
    }>(
      `SELECT backfilled, data_status FROM universe_symbol WHERE symbol = 'BRK.B'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ backfilled: true, data_status: 'ok' });
    expect(await count('universe_symbol', 'BRK-B')).toBe(0);
  });

  it('repoints every FK child — nothing is silently cascade-deleted', async () => {
    for (const table of [
      'price_bar',
      'etf_weight',
      'symbol_metadata',
      'symbol_branding',
    ]) {
      expect(await count(table, 'BRK.B')).toBe(1); // survived under new key
      expect(await count(table, 'BRK-B')).toBe(0); // none left under old key
    }
  });
});
