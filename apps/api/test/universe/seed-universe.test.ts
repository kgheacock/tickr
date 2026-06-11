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

// Control the "live" constituent list per test; the reconcile logic under test
// consumes whatever this resolves/rejects with.
vi.mock('../../src/universe/wikipedia.js', () => ({
  fetchSp500Symbols: vi.fn(),
  WikipediaUniverseError: class WikipediaUniverseError extends Error {},
}));

let container: StartedPostgreSqlContainer;
let client: pg.Client;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();

  const connectionString = container.getConnectionUri();
  // The app pool (db/pool.js) reads DATABASE_URL lazily on first query — set it
  // before seedUniverse runs so it targets the container.
  process.env['DATABASE_URL'] = connectionString;

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
  const { closePool } = await import('../../src/db/pool.js');
  await closePool();
  await client?.end();
  await container?.stop();
});

beforeEach(async () => {
  await client.query(`DELETE FROM universe_symbol`);
  vi.clearAllMocks();
});

async function mockLive(symbols: string[]): Promise<void> {
  const { fetchSp500Symbols } = await import('../../src/universe/wikipedia.js');
  vi.mocked(fetchSp500Symbols).mockResolvedValue(symbols);
}

async function mockLiveFails(): Promise<void> {
  const { fetchSp500Symbols } = await import('../../src/universe/wikipedia.js');
  vi.mocked(fetchSp500Symbols).mockRejectedValue(new Error('offline'));
}

async function insertActive(...symbols: string[]): Promise<void> {
  for (const s of symbols) {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
      [s],
    );
  }
}

async function removedAt(symbol: string): Promise<Date | null> {
  const { rows } = await client.query<{ removed_at: Date | null }>(
    `SELECT removed_at FROM universe_symbol WHERE symbol = $1`,
    [symbol],
  );
  return rows[0]?.removed_at ?? null;
}

async function activeSymbols(): Promise<string[]> {
  const { rows } = await client.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol WHERE removed_at IS NULL ORDER BY symbol`,
  );
  return rows.map((r) => r.symbol);
}

describe('seedUniverse reconciliation', () => {
  it('inserts new members, preserving dotted symbols', async () => {
    await mockLive(['AAPL', 'MSFT', 'BRK.B']);
    const { seedUniverse } = await import('../../src/db/seed-universe.js');
    await seedUniverse();

    expect(await activeSymbols()).toEqual(['AAPL', 'BRK.B', 'MSFT']);
  });

  it('retires departed members (removed_at) without deleting the row', async () => {
    // 20 active so a single departure stays under the 10% departure cap.
    const base = Array.from({ length: 19 }, (_, i) => `SY${i}`);
    await insertActive(...base, 'OLD');
    await mockLive(base); // OLD dropped from the index

    const { seedUniverse } = await import('../../src/db/seed-universe.js');
    await seedUniverse();

    // Row still exists…
    const { rows } = await client.query(
      `SELECT 1 FROM universe_symbol WHERE symbol = 'OLD'`,
    );
    expect(rows).toHaveLength(1);
    // …but is now terminal (removed_at set) and excluded from active members.
    expect(await removedAt('OLD')).toBeInstanceOf(Date);
    expect(await activeSymbols()).not.toContain('OLD');
  });

  it('reactivates a returning member (clears removed_at)', async () => {
    await insertActive('AAPL');
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled, removed_at)
       VALUES ('GONE', true, now())`,
    );
    await mockLive(['AAPL', 'GONE']); // GONE re-added to the index

    const { seedUniverse } = await import('../../src/db/seed-universe.js');
    await seedUniverse();

    expect(await removedAt('GONE')).toBeNull();
    expect(await activeSymbols()).toEqual(['AAPL', 'GONE']);
  });

  it('skips retirement when departures exceed the safety cap', async () => {
    const base = Array.from({ length: 20 }, (_, i) => `SY${i}`);
    await insertActive(...base);
    await mockLive([base[0]!]); // implausibly claims only 1 member remains

    const { seedUniverse } = await import('../../src/db/seed-universe.js');
    await seedUniverse();

    // No mass retirement — every member stays active.
    expect(await activeSymbols()).toHaveLength(20);
  });

  it('falls back to the bundled CSV on fetch failure (inserts only, no retirement)', async () => {
    await insertActive('OLD');
    await mockLiveFails();

    const { seedUniverse } = await import('../../src/db/seed-universe.js');
    await seedUniverse();

    const active = await activeSymbols();
    // CSV symbols inserted (dotted form), and the pre-existing OLD is untouched.
    expect(active).toContain('AAPL');
    expect(active).toContain('BRK.B');
    expect(await removedAt('OLD')).toBeNull();
  });
});
