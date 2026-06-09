import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { runAudit, CODE } from '../../src/audit/run-audit.js';
import type { AuditConfig } from '../../src/audit/run-audit.js';

pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, parseFloat);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;

const DAY_MS = 24 * 60 * 60 * 1000;

// Stable Monday anchor. Short window keeps seeding fast.
const T0 = new Date('2024-07-08T12:00:00Z').getTime();

function tradingDay(offsetDays: number): Date {
  return new Date(T0 + offsetDays * DAY_MS);
}

async function insertBar(
  symbol: string,
  ts: Date,
  {
    open = 10000,
    high = 10100,
    low = 9900,
    close = 10050,
    volume = 1000,
  }: Partial<{
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [symbol, ts.toISOString(), open, high, low, close, volume],
  );
}

async function seedSymbol(symbol: string, backfilled = true): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled)
     VALUES ($1, $2)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol, backfilled],
  );
}

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
  pool = new pg.Pool({ connectionString, max: 3 });
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await client?.end();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await client.query('DELETE FROM price_bar');
  await client.query('DELETE FROM universe_symbol');
});

function weekConfig(overrides: Partial<AuditConfig> = {}): AuditConfig {
  return {
    startMs: T0,
    endMs: T0 + 4 * DAY_MS, // Mon–Fri
    multiplier: 15,
    timespan: 'minute',
    gapThreshold: 3,
    crossSourceThreshold: 0.01,
    splitTolerance: 0.03,
    intradayGapMinutes: 30,
    ...overrides,
  };
}

// ─── clean corpus ─────────────────────────────────────────────────────────────

describe('clean corpus', () => {
  it('exits with 0 errors when symbol has full intraday coverage', async () => {
    await seedSymbol('AAPL');

    for (let dayOff = 0; dayOff <= 4; dayOff++) {
      const dayBase = new Date(T0 + dayOff * DAY_MS);
      dayBase.setUTCHours(0, 0, 0, 0);
      for (let minOff = 0; minOff < 6 * 60; minOff += 15) {
        const ts = new Date(
          dayBase.getTime() + 14 * 3600_000 + minOff * 60_000,
        );
        await insertBar('AAPL', ts);
      }
    }

    const report = await runAudit(pool, weekConfig());
    expect(report.summary.symbolsWithErrors).toBe(0);
    expect(report.errorCounts[CODE.NO_BARS]).toBe(0);
    expect(report.errorCounts[CODE.COVERAGE_GAP]).toBe(0);
    expect(report.errorCounts[CODE.OHLC_VIOLATION]).toBe(0);
    expect(report.errorCounts[CODE.DUPLICATE_BAR]).toBe(0);
    expect(report.errorCounts[CODE.INTRADAY_GAP]).toBe(0);
    expect(report.errorCounts[CODE.CROSS_SOURCE_DEVIATION]).toBe(0);
  });
});

// ─── NO_BARS ──────────────────────────────────────────────────────────────────

describe('NO_BARS', () => {
  it('fires when a backfilled symbol has zero price_bar rows', async () => {
    await seedSymbol('MSFT');

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.NO_BARS]).toBe(1);
    expect(
      report.symbols['MSFT']?.issues.some((i) => i.code === CODE.NO_BARS),
    ).toBe(true);
  });

  it('does not fire for a symbol with backfilled=false', async () => {
    await seedSymbol('GOOG', false);

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.NO_BARS]).toBe(0);
    expect(
      report.symbols['GOOG']?.issues.some(
        (i) => i.code === CODE.NOT_BACKFILLED && i.severity === 'warning',
      ),
    ).toBe(true);
  });
});

// ─── COVERAGE_GAP ─────────────────────────────────────────────────────────────

describe('COVERAGE_GAP', () => {
  it('fires when >= gapThreshold consecutive trading days are missing', async () => {
    await seedSymbol('TSLA');
    await insertBar('TSLA', new Date(T0 + 0 * DAY_MS + 14 * 3600_000)); // Mon
    await insertBar('TSLA', new Date(T0 + 4 * DAY_MS + 14 * 3600_000)); // Fri

    const report = await runAudit(
      pool,
      weekConfig({ gapThreshold: 3, timespan: 'day', multiplier: 1 }),
    );
    expect(report.errorCounts[CODE.COVERAGE_GAP]).toBeGreaterThanOrEqual(1);
  });

  it('does not fire when gap is below threshold', async () => {
    await seedSymbol('NVDA');
    for (const dayOff of [0, 2, 3, 4]) {
      await insertBar('NVDA', new Date(T0 + dayOff * DAY_MS + 14 * 3600_000));
    }

    const report = await runAudit(
      pool,
      weekConfig({ gapThreshold: 3, timespan: 'day', multiplier: 1 }),
    );
    expect(report.errorCounts[CODE.COVERAGE_GAP]).toBe(0);
  });
});

// ─── OHLC_VIOLATION ───────────────────────────────────────────────────────────

describe('OHLC_VIOLATION', () => {
  it('fires when low > open', async () => {
    await seedSymbol('AMZN');
    await insertBar('AMZN', tradingDay(0), {
      open: 10000,
      high: 10200,
      low: 10100,
      close: 10050,
    });

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.OHLC_VIOLATION]).toBe(1);
  });

  it('fires when close > high', async () => {
    await seedSymbol('META');
    await insertBar('META', tradingDay(0), {
      open: 10000,
      high: 10100,
      low: 9900,
      close: 10200,
    });

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.OHLC_VIOLATION]).toBe(1);
  });

  it('fires when volume is negative', async () => {
    await seedSymbol('GOOGL');
    await insertBar('GOOGL', tradingDay(0), { volume: -1 });

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.OHLC_VIOLATION]).toBe(1);
  });

  it('allows null volume (some bars omit volume)', async () => {
    await seedSymbol('AAPL');
    await insertBar('AAPL', tradingDay(0), { volume: null });

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.OHLC_VIOLATION]).toBe(0);
  });
});

// ─── DUPLICATE_BAR ────────────────────────────────────────────────────────────

describe('DUPLICATE_BAR', () => {
  it('fires when two bars land in the same 15-minute bucket', async () => {
    await seedSymbol('NFLX');
    const base = new Date(T0);
    base.setUTCHours(14, 30, 0, 0);
    await insertBar('NFLX', base);
    await insertBar('NFLX', new Date(base.getTime() + 60_000)); // +1 min, same bucket

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.DUPLICATE_BAR]).toBe(1);
  });

  it('does not fire for bars in adjacent 15-minute buckets', async () => {
    await seedSymbol('SPOT');
    const base = new Date(T0);
    base.setUTCHours(14, 30, 0, 0);
    await insertBar('SPOT', base);
    await insertBar('SPOT', new Date(base.getTime() + 15 * 60_000)); // next bucket

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.DUPLICATE_BAR]).toBe(0);
  });
});

// ─── CROSS_SOURCE_DEVIATION ───────────────────────────────────────────────────

describe('CROSS_SOURCE_DEVIATION', () => {
  it('fires when midnight bar and intraday close diverge > 1%', async () => {
    await seedSymbol('ORCL');
    const midnight = new Date(T0);
    midnight.setUTCHours(0, 0, 0, 0);
    await insertBar('ORCL', midnight, { close: 10000 });

    const intraday = new Date(T0);
    intraday.setUTCHours(20, 0, 0, 0);
    await insertBar('ORCL', intraday, { close: 10200 }); // 2% deviation

    const report = await runAudit(
      pool,
      weekConfig({ crossSourceThreshold: 0.01 }),
    );
    expect(report.errorCounts[CODE.CROSS_SOURCE_DEVIATION]).toBe(1);
  });

  it('does not fire when deviation is within threshold', async () => {
    await seedSymbol('IBM');
    const midnight = new Date(T0);
    midnight.setUTCHours(0, 0, 0, 0);
    await insertBar('IBM', midnight, { close: 10000 });

    const intraday = new Date(T0);
    intraday.setUTCHours(20, 0, 0, 0);
    await insertBar('IBM', intraday, { close: 10005 }); // 0.05% deviation

    const report = await runAudit(
      pool,
      weekConfig({ crossSourceThreshold: 0.01 }),
    );
    expect(report.errorCounts[CODE.CROSS_SOURCE_DEVIATION]).toBe(0);
  });
});

// ─── INTRADAY_GAP ─────────────────────────────────────────────────────────────

describe('INTRADAY_GAP — no_session_bars (daily-only data)', () => {
  it('fires when a backfilled symbol has only midnight-UTC bars', async () => {
    await seedSymbol('BRK-A');
    for (let d = 0; d <= 4; d++) {
      const ts = new Date(T0 + d * DAY_MS);
      ts.setUTCHours(0, 0, 0, 0); // midnight UTC = daily-bar pattern
      await insertBar('BRK-A', ts);
    }

    const report = await runAudit(pool, weekConfig({ timespan: 'minute' }));
    const issues = report.symbols['BRK-A']?.issues ?? [];
    expect(
      issues.some(
        (i) =>
          i.code === CODE.INTRADAY_GAP &&
          (i.detail as { type: string }).type === 'no_session_bars',
      ),
    ).toBe(true);
  });

  it('does not fire when TIMESPAN is day', async () => {
    await seedSymbol('JNJ');
    const ts = new Date(T0);
    ts.setUTCHours(0, 0, 0, 0);
    await insertBar('JNJ', ts);

    const report = await runAudit(
      pool,
      weekConfig({ timespan: 'day', multiplier: 1 }),
    );
    expect(report.errorCounts[CODE.INTRADAY_GAP]).toBe(0);
  });
});

describe('INTRADAY_GAP — session_gap', () => {
  it('fires when consecutive within-session bars are > 30 min apart', async () => {
    await seedSymbol('WMT');
    const base = new Date(T0);
    base.setUTCHours(14, 30, 0, 0);
    await insertBar('WMT', base);
    await insertBar('WMT', new Date(base.getTime() + 90 * 60_000)); // 90 min gap

    const report = await runAudit(pool, weekConfig({ intradayGapMinutes: 30 }));
    const issues = report.symbols['WMT']?.issues ?? [];
    expect(
      issues.some(
        (i) =>
          i.code === CODE.INTRADAY_GAP &&
          (i.detail as { type: string }).type === 'session_gap',
      ),
    ).toBe(true);
  });

  it('does not fire when the gap is at or below threshold', async () => {
    await seedSymbol('HD');
    const base = new Date(T0);
    base.setUTCHours(14, 30, 0, 0);
    await insertBar('HD', base);
    await insertBar('HD', new Date(base.getTime() + 15 * 60_000)); // 15 min

    const report = await runAudit(pool, weekConfig({ intradayGapMinutes: 30 }));
    expect(report.errorCounts[CODE.INTRADAY_GAP]).toBe(0);
  });
});

// ─── SPLIT_CANDIDATE (warning, not error) ─────────────────────────────────────

describe('SPLIT_CANDIDATE', () => {
  // Two-day window so no trailing COVERAGE_GAP fires alongside the split warning.
  const splitConfig = (): AuditConfig => ({
    ...weekConfig(),
    endMs: T0 + DAY_MS,
  });

  it('emits a warning (not an error) for a 2:1 forward-split ratio', async () => {
    await seedSymbol('TSLA');

    const day0 = new Date(T0);
    day0.setUTCHours(20, 45, 0, 0);
    await insertBar('TSLA', day0, {
      open: 19900,
      high: 20100,
      low: 19800,
      close: 20000,
    });

    const day1 = new Date(T0 + DAY_MS);
    day1.setUTCHours(20, 45, 0, 0);
    await insertBar('TSLA', day1, {
      open: 9900,
      high: 10100,
      low: 9800,
      close: 10000,
    });

    const report = await runAudit(pool, splitConfig());
    expect(report.errorCounts[CODE.SPLIT_CANDIDATE]).toBe(1);

    const issues = report.symbols['TSLA']?.issues ?? [];
    const splitIssue = issues.find((i) => i.code === CODE.SPLIT_CANDIDATE);
    expect(splitIssue?.severity).toBe('warning');
    // Key contract: warning-only corpus must NOT increment symbolsWithErrors.
    expect(report.summary.symbolsWithErrors).toBe(0);
    expect(report.summary.symbolsWithWarnings).toBe(1);
  });

  it('exit-code contract: warning-only corpus → symbolsWithErrors === 0', async () => {
    await seedSymbol('PLTR');

    const day0 = new Date(T0);
    day0.setUTCHours(20, 45, 0, 0);
    await insertBar('PLTR', day0, {
      open: 19900,
      high: 20100,
      low: 19800,
      close: 20000,
    });

    const day1 = new Date(T0 + DAY_MS);
    day1.setUTCHours(20, 45, 0, 0);
    await insertBar('PLTR', day1, {
      open: 9900,
      high: 10100,
      low: 9800,
      close: 10000,
    });

    const report = await runAudit(pool, splitConfig());
    expect(report.summary.symbolsWithErrors).toBe(0);
  });
});

// ─── NOT_BACKFILLED (warning) ─────────────────────────────────────────────────

describe('NOT_BACKFILLED', () => {
  it('emits a warning for a symbol with backfilled=false', async () => {
    await seedSymbol('CRM', false);

    const report = await runAudit(pool, weekConfig());
    expect(report.errorCounts[CODE.NOT_BACKFILLED]).toBe(1);
    const issues = report.symbols['CRM']?.issues ?? [];
    expect(issues.find((i) => i.code === CODE.NOT_BACKFILLED)?.severity).toBe(
      'warning',
    );
    expect(report.summary.symbolsWithErrors).toBe(0);
  });
});
