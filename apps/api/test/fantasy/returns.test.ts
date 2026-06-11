import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { weeklyReturn } from '../../src/fantasy/returns.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_returns_test')
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
  pool = new pg.Pool({ connectionString });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// A Friday week-end and its prior Friday.
const PRIOR_FRIDAY = new Date('2026-06-05T20:00:00Z');
const WEEK_END = new Date('2026-06-12T21:35:00Z'); // job fires after Friday close

async function seedSymbol(symbol: string): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol],
  );
}

/** Insert a price_bar close (cents) at a timestamp. */
async function seedBar(symbol: string, ts: Date, close: number): Promise<void> {
  await pool.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close)
     VALUES ($1, $2, $3, $3, $3, $3)`,
    [symbol, ts, close],
  );
}

beforeEach(async () => {
  await pool.query('DELETE FROM price_bar');
  await pool.query('DELETE FROM universe_symbol');
});

describe('weeklyReturn', () => {
  it('computes the percent move between the two Friday closes', async () => {
    await seedSymbol('AAA');
    await seedBar('AAA', PRIOR_FRIDAY, 10_000); // $100.00
    await seedBar('AAA', new Date('2026-06-12T20:00:00Z'), 9_600); // $96.00
    const r = await weeklyReturn(pool, 'AAA', WEEK_END);
    expect(r.lastClose).toBe(10_000);
    expect(r.thisClose).toBe(9_600);
    expect(r.returnPct).toBeCloseTo(-4, 10);
  });

  it('is scale-invariant in the close units', async () => {
    await seedSymbol('BBB');
    await seedBar('BBB', PRIOR_FRIDAY, 5_000);
    await seedBar('BBB', new Date('2026-06-12T20:00:00Z'), 6_500); // +30%
    const r = await weeklyReturn(pool, 'BBB', WEEK_END);
    expect(r.returnPct).toBeCloseTo(30, 10);
  });

  it('floors a wipeout at −100% (close → 0)', async () => {
    await seedSymbol('ZERO');
    await seedBar('ZERO', PRIOR_FRIDAY, 4_200);
    await seedBar('ZERO', new Date('2026-06-12T20:00:00Z'), 0);
    const r = await weeklyReturn(pool, 'ZERO', WEEK_END);
    expect(r.returnPct).toBeCloseTo(-100, 10);
  });

  it('walks back to the last available close in a holiday-short week', async () => {
    await seedSymbol('HOL');
    await seedBar('HOL', PRIOR_FRIDAY, 10_000);
    // No Friday bar; the latest before week-end is Thursday.
    await seedBar('HOL', new Date('2026-06-11T20:00:00Z'), 11_000); // Thu +10%
    const r = await weeklyReturn(pool, 'HOL', WEEK_END);
    expect(r.thisClose).toBe(11_000);
    expect(r.returnPct).toBeCloseTo(10, 10);
  });

  it('returns null returnPct when a close is missing', async () => {
    await seedSymbol('GONE');
    await seedBar('GONE', new Date('2026-06-12T20:00:00Z'), 5_000); // no baseline
    const r = await weeklyReturn(pool, 'GONE', WEEK_END);
    expect(r.lastClose).toBeNull();
    expect(r.returnPct).toBeNull();
  });

  it('caps the this-close at asOf for provisional in-week scoring', async () => {
    await seedSymbol('LIVE');
    await seedBar('LIVE', PRIOR_FRIDAY, 10_000);
    await seedBar('LIVE', new Date('2026-06-09T20:00:00Z'), 10_500); // Tue +5%
    await seedBar('LIVE', new Date('2026-06-12T20:00:00Z'), 12_000); // Fri +20%
    const asOf = new Date('2026-06-09T21:35:00Z'); // mid-week
    const r = await weeklyReturn(pool, 'LIVE', WEEK_END, asOf);
    expect(r.thisClose).toBe(10_500);
    expect(r.returnPct).toBeCloseTo(5, 10);
  });
});
