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

async function seedSymbol(
  symbol: string,
  backfilled = true,
  dataStatus: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled, data_status)
     VALUES ($1, $2, $3)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol, backfilled, dataStatus],
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
    splitTolerance: 0.03,
    intradayGapMinutes: 30,
    sessionOpenEt: '09:30',
    sessionCloseEt: '16:00',
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

// ─── COVERAGE_GAP severity by position ────────────────────────────────────────

describe('COVERAGE_GAP severity by position', () => {
  // A leading gap = history starts late (almost always a listing/IPO after the
  // window start, e.g. EXE/Expand Energy). The pre-listing data cannot be
  // fetched, so it must be a warning, not a deploy-blocking error.
  it('leading gap is a warning, not an error', async () => {
    await seedSymbol('EXE');
    // Present only on the last two days → the leading days are missing.
    // tradingDay() stays at noon UTC so each bar lands on its intended date.
    await insertBar('EXE', tradingDay(3)); // Thu
    await insertBar('EXE', tradingDay(4)); // Fri

    const report = await runAudit(
      pool,
      weekConfig({ gapThreshold: 3, timespan: 'day', multiplier: 1 }),
    );
    const issue = report.symbols['EXE']?.issues.find(
      (i) => i.code === CODE.COVERAGE_GAP,
    );
    expect((issue?.detail as { position: string }).position).toBe('leading');
    expect(issue?.severity).toBe('warning');
    expect(report.symbols['EXE']?.status).toBe('warning');
    expect(report.summary.symbolsWithErrors).toBe(0);
  });

  // An internal gap = a hole in the middle of otherwise-present history = real
  // data loss → must stay an error.
  it('internal gap is an error', async () => {
    await seedSymbol('TSLA');
    await insertBar('TSLA', tradingDay(0)); // Mon
    await insertBar('TSLA', tradingDay(4)); // Fri — Tue/Wed/Thu missing = internal

    const report = await runAudit(
      pool,
      weekConfig({ gapThreshold: 3, timespan: 'day', multiplier: 1 }),
    );
    const issue = report.symbols['TSLA']?.issues.find(
      (i) => i.code === CODE.COVERAGE_GAP,
    );
    expect((issue?.detail as { position: string }).position).toBe('internal');
    expect(issue?.severity).toBe('error');
    expect(report.summary.symbolsWithErrors).toBe(1);
  });
});

// ─── EXCLUDED (data_status = 'incomplete') ────────────────────────────────────

describe("EXCLUDED — data_status = 'incomplete'", () => {
  // Delisted/depth-capped symbols are excluded from the playable corpus. They
  // would otherwise trip COVERAGE_GAP (trailing) or NO_BARS, but must be skipped
  // and surfaced as a warning so they never block a deploy.
  it('skips all hard checks and warns instead', async () => {
    await seedSymbol('CTLT', true, 'incomplete');
    // Only the first day has data → a long trailing gap that would be an error
    // for a playable symbol.
    await insertBar('CTLT', new Date(T0 + 0 * DAY_MS + 14 * 3600_000));

    const report = await runAudit(
      pool,
      weekConfig({ gapThreshold: 3, timespan: 'day', multiplier: 1 }),
    );
    expect(report.summary.symbolsWithErrors).toBe(0);
    expect(report.errorCounts[CODE.COVERAGE_GAP]).toBe(0);
    expect(report.symbols['CTLT']?.status).toBe('warning');
    expect(
      report.symbols['CTLT']?.issues.some(
        (i) => i.code === CODE.EXCLUDED && i.severity === 'warning',
      ),
    ).toBe(true);
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
  // A within-session gap is data sparsity (thin/high-priced names), not
  // corruption — so it is a warning and must NOT block a deploy.
  it('flags a within-session gap as a warning, not an error', async () => {
    await seedSymbol('WMT');
    // Full 15-min session coverage every day so the symbol has no coverage gap;
    // the ONLY issue is a single 90-min hole on day 0 (skip 14:15–15:15 UTC).
    for (let dayOff = 0; dayOff <= 4; dayOff++) {
      const dayBase = new Date(T0 + dayOff * DAY_MS);
      dayBase.setUTCHours(0, 0, 0, 0);
      for (let minOff = 0; minOff < 6 * 60; minOff += 15) {
        if (dayOff === 0 && minOff > 0 && minOff < 90) continue;
        await insertBar(
          'WMT',
          new Date(dayBase.getTime() + 14 * 3600_000 + minOff * 60_000),
        );
      }
    }

    const report = await runAudit(pool, weekConfig({ intradayGapMinutes: 30 }));
    const issue = report.symbols['WMT']?.issues.find(
      (i) =>
        i.code === CODE.INTRADAY_GAP &&
        (i.detail as { type: string }).type === 'session_gap',
    );
    expect(issue?.severity).toBe('warning');
    expect(report.symbols['WMT']?.status).toBe('warning');
    expect(report.summary.symbolsWithErrors).toBe(0);
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

  // Regression guard for Finding 1: a gap that lives ONLY in post-market hours
  // must not be flagged. Continuous in-session bars (10:00–15:45 ET) followed by
  // a lone post-close bar (17:00 ET) >30 min later — under the old
  // `BETWEEN 13 AND 22` UTC window this fired a false session_gap.
  it('ignores a gap that falls entirely in post-market hours', async () => {
    await seedSymbol('NVDA');
    const day = new Date(T0);
    // Continuous regular-session bars: 14:00→19:45 UTC = 10:00→15:45 ET (EDT).
    for (let h = 14 * 60; h <= 19 * 60 + 45; h += 15) {
      const ts = new Date(T0);
      ts.setUTCHours(0, 0, 0, 0);
      await insertBar('NVDA', new Date(ts.getTime() + h * 60_000));
    }
    // Lone post-close bar at 21:00 UTC = 17:00 ET, 75 min after the last
    // session bar — outside the regular session, so it must be ignored.
    const postClose = new Date(day);
    postClose.setUTCHours(21, 0, 0, 0);
    await insertBar('NVDA', postClose);

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
    day0.setUTCHours(18, 0, 0, 0); // 14:00 ET — within the regular session
    await insertBar('TSLA', day0, {
      open: 19900,
      high: 20100,
      low: 19800,
      close: 20000,
    });

    const day1 = new Date(T0 + DAY_MS);
    day1.setUTCHours(18, 0, 0, 0); // 14:00 ET — within the regular session
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
    day0.setUTCHours(18, 0, 0, 0); // 14:00 ET — within the regular session
    await insertBar('PLTR', day0, {
      open: 19900,
      high: 20100,
      low: 19800,
      close: 20000,
    });

    const day1 = new Date(T0 + DAY_MS);
    day1.setUTCHours(18, 0, 0, 0); // 14:00 ET — within the regular session
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
