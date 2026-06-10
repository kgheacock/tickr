import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import {
  percentile,
  metricsFor,
  assignGroups,
  runClassifier,
  type SymbolMetrics,
} from '../../src/fantasy/classify.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

// ---------------------------------------------------------------------------
// Pure helpers — no DB
// ---------------------------------------------------------------------------

describe('percentile', () => {
  it('linear interpolation; quartiles of [10,20,30,40]', () => {
    expect(percentile([10, 20, 30, 40], 0.75)).toBeCloseTo(32.5, 6);
    expect(percentile([10, 20, 30, 40], 0.25)).toBeCloseTo(17.5, 6);
  });
  it('ignores non-finite and handles small inputs', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([42], 0.9)).toBe(42);
    expect(percentile([1, NaN, 3], 0.5)).toBeCloseTo(2, 6);
  });
});

describe('metricsFor', () => {
  it('computes trailing return and null sigma for too-few bars', () => {
    const m = metricsFor('X', [
      { close: 100, volume: 10 },
      { close: 110, volume: 20 },
    ]);
    expect(m.ret3mPct).toBeCloseTo(10, 6); // 100 → 110
    expect(m.avgVolume).toBeCloseTo(15, 6);
    expect(m.sigma).toBeNull(); // needs ≥3 bars
  });
});

describe('assignGroups', () => {
  it('assigns each group to the expected symbol; defense+wildcard universal', () => {
    const metrics: SymbolMetrics[] = [
      {
        symbol: 'ANCH',
        ret3mPct: 1,
        ret12mPct: 10,
        sigma: 0.01,
        avgVolume: 1000,
      },
      {
        symbol: 'GROW',
        ret3mPct: 5,
        ret12mPct: 90,
        sigma: 0.05,
        avgVolume: 100,
      },
      {
        symbol: 'MOMO',
        ret3mPct: 50,
        ret12mPct: 20,
        sigma: 0.04,
        avgVolume: 200,
      },
      {
        symbol: 'VALU',
        ret3mPct: 2,
        ret12mPct: -30,
        sigma: 0.03,
        avgVolume: 300,
      },
    ];
    const g = assignGroups(metrics);

    for (const s of ['ANCH', 'GROW', 'MOMO', 'VALU']) {
      expect(g.get(s)).toEqual(expect.arrayContaining(['defense', 'wildcard']));
      expect(g.get(s)!.length).toBeGreaterThanOrEqual(2);
    }
    expect(g.get('ANCH')).toContain('anchor');
    expect(g.get('GROW')).toContain('growth');
    expect(g.get('MOMO')).toContain('momentum');
    expect(g.get('VALU')).toContain('value');
    // Value excludes Growth names.
    expect(g.get('GROW')).not.toContain('value');
  });

  it('anchor is null-volume safe (low-σ qualifies without volume data)', () => {
    const metrics: SymbolMetrics[] = [
      { symbol: 'A', ret3mPct: 0, ret12mPct: 0, sigma: 0.01, avgVolume: null },
      { symbol: 'B', ret3mPct: 0, ret12mPct: 0, sigma: 0.5, avgVolume: 50 },
      { symbol: 'C', ret3mPct: 0, ret12mPct: 0, sigma: 0.6, avgVolume: 60 },
    ];
    const g = assignGroups(metrics);
    expect(g.get('A')).toContain('anchor');
    expect(g.get('B')).not.toContain('anchor');
  });
});

// ---------------------------------------------------------------------------
// runClassifier — DB, idempotency
// ---------------------------------------------------------------------------

describe('runClassifier', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
      .withDatabase('tickr_classify_test')
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

  beforeEach(async () => {
    await pool.query('DELETE FROM fs_player_classification');
    await pool.query('DELETE FROM price_bar');
    await pool.query('DELETE FROM universe_symbol');
  });

  async function seed(symbol: string, closes: number[]): Promise<void> {
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
      [symbol],
    );
    for (let i = 0; i < closes.length; i++) {
      const ts = new Date(Date.UTC(2024, 0, 1 + i)).toISOString();
      await pool.query(
        `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
         VALUES ($1, $2, $3, $3, $3, $3, $4)`,
        [symbol, ts, closes[i], 1000 + i],
      );
    }
  }

  it('assigns ≥1 group per backfilled symbol, writes metrics, and is idempotent', async () => {
    await seed('AAA', [100, 102, 101, 104, 108]);
    await seed('BBB', [50, 48, 47, 49, 40]);
    await seed('CCC', [10, 11, 12, 13, 20]);

    const n = await runClassifier(pool);
    expect(n).toBe(3);

    const first = await pool.query<{
      symbol: string;
      group: string;
      eligible: boolean;
      metrics: unknown;
    }>(
      `SELECT symbol, "group", eligible, metrics
         FROM fs_player_classification ORDER BY symbol, "group"`,
    );
    // Every symbol gets at least defense + wildcard, and metrics are written.
    for (const sym of ['AAA', 'BBB', 'CCC']) {
      const groups = first.rows.filter((r) => r.symbol === sym);
      expect(groups.length).toBeGreaterThanOrEqual(1);
      expect(groups.map((r) => r.group)).toEqual(
        expect.arrayContaining(['defense', 'wildcard']),
      );
      expect(groups.every((r) => r.metrics != null)).toBe(true);
    }

    // Idempotent: a second run yields the same (symbol, group, eligible, metrics).
    await runClassifier(pool);
    const second = await pool.query<{
      symbol: string;
      group: string;
      eligible: boolean;
      metrics: unknown;
    }>(
      `SELECT symbol, "group", eligible, metrics
         FROM fs_player_classification ORDER BY symbol, "group"`,
    );
    expect(second.rows).toEqual(first.rows);
  });

  it('skips non-backfilled symbols', async () => {
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('NBF', false)`,
    );
    const n = await runClassifier(pool);
    expect(n).toBe(0);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS c FROM fs_player_classification`,
    );
    expect((rows[0] as { c: number }).c).toBe(0);
  });
});
