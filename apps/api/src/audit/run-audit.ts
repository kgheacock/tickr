import type pg from 'pg';
import { isNyseHoliday } from '../market/holidays.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export const CODE = {
  NO_BARS: 'NO_BARS',
  COVERAGE_GAP: 'COVERAGE_GAP',
  OHLC_VIOLATION: 'OHLC_VIOLATION',
  DUPLICATE_BAR: 'DUPLICATE_BAR',
  CROSS_SOURCE_DEVIATION: 'CROSS_SOURCE_DEVIATION',
  INTRADAY_GAP: 'INTRADAY_GAP',
  NOT_BACKFILLED: 'NOT_BACKFILLED',
  SPLIT_CANDIDATE: 'SPLIT_CANDIDATE',
} as const;

export type ErrorCode = (typeof CODE)[keyof typeof CODE];

export interface Issue {
  code: ErrorCode;
  severity: 'error' | 'warning';
  detail: Record<string, unknown>;
}

export interface SymbolAudit {
  status: 'clean' | 'warning' | 'error';
  issues: Issue[];
}

export interface AuditConfig {
  /** UTC epoch ms — expected coverage start (from BACKFILL_START_DATE or LOOKBACK_DAYS). */
  startMs: number;
  /** UTC epoch ms — latest expected trading day (typically yesterday). */
  endMs: number;
  /** BACKFILL_MULTIPLIER — bar granularity multiplier. */
  multiplier: number;
  /** BACKFILL_TIMESPAN — bar granularity unit. */
  timespan: string;
  /** Consecutive missing trading days before flagging COVERAGE_GAP. */
  gapThreshold: number;
  /** Fractional close deviation before flagging CROSS_SOURCE_DEVIATION. */
  crossSourceThreshold: number;
  /** Fractional tolerance around known split ratios. */
  splitTolerance: number;
  /** Max gap (minutes) between consecutive within-session bars. */
  intradayGapMinutes: number;
}

export interface AuditReport {
  runAt: string;
  config: {
    expectedStartDate: string;
    gapThresholdDays: number;
    crossSourceThreshold: number;
    granularity: string;
  };
  summary: {
    totalSymbols: number;
    symbolsClean: number;
    symbolsWithWarnings: number;
    symbolsWithErrors: number;
  };
  errorCounts: Record<ErrorCode, number>;
  /** Only contains symbols that have at least one issue. */
  symbols: Record<string, SymbolAudit>;
}

// ─── Pure helpers (exported for unit tests) ───────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Returns true if dateStr (YYYY-MM-DD) is a US equity trading day.
 * Passes noon UTC to isNyseHoliday to avoid the midnight-UTC-to-prior-ET-day trap.
 */
export function isTradingDay(dateStr: string): boolean {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !isNyseHoliday(d);
}

/** Returns YYYY-MM-DD strings for every trading day in [startMs, endMs]. */
export function computeExpectedTradingDays(
  startMs: number,
  endMs: number,
): string[] {
  const days: string[] = [];
  let cursor = startMs;
  while (cursor <= endMs) {
    const dateStr = new Date(cursor).toISOString().slice(0, 10);
    if (isTradingDay(dateStr)) days.push(dateStr);
    cursor += DAY_MS;
  }
  return days;
}

/** Finds runs of missing trading days >= gapThreshold in length. */
export function findCoverageGaps(
  expectedDays: string[],
  presentDates: Set<string>,
  gapThreshold: number,
): Array<{ gapStart: string; gapEnd: string; missingTradingDays: number }> {
  const gaps: Array<{
    gapStart: string;
    gapEnd: string;
    missingTradingDays: number;
  }> = [];
  let gapStart: string | null = null;
  let gapEnd: string | null = null;
  let gapCount = 0;

  for (const day of expectedDays) {
    if (!presentDates.has(day)) {
      if (gapStart === null) gapStart = day;
      gapEnd = day;
      gapCount++;
    } else {
      if (gapCount >= gapThreshold && gapStart !== null && gapEnd !== null) {
        gaps.push({ gapStart, gapEnd, missingTradingDays: gapCount });
      }
      gapStart = null;
      gapEnd = null;
      gapCount = 0;
    }
  }
  if (gapCount >= gapThreshold && gapStart !== null && gapEnd !== null) {
    gaps.push({ gapStart, gapEnd, missingTradingDays: gapCount });
  }
  return gaps;
}

/**
 * Returns a SQL expression that truncates ts to the configured granularity bucket.
 * Multiplier and timespan are caller-validated — safe to inline in SQL.
 */
export function buildBucketExpr(multiplier: number, timespan: string): string {
  if (timespan === 'day' || timespan === 'week' || timespan === 'month') {
    return `date_trunc('${timespan}', ts)`;
  }
  if (timespan === 'hour') {
    return multiplier === 1
      ? `date_trunc('hour', ts)`
      : `date_trunc('hour', ts) + floor(extract(hour from ts) % ${multiplier}) * interval '${multiplier} hours'`;
  }
  // second or minute
  return `date_trunc('hour', ts) + floor(extract(minute from ts) / ${multiplier}) * interval '${multiplier} minutes'`;
}

/**
 * Returns a human-readable split label for a consecutive-day close ratio.
 *   ratio < 1 → price dropped  → forward split  (e.g. 0.5 ≈ 2:1)
 *   ratio > 1 → price rose     → reverse split  (e.g. 2.0 ≈ 1:2)
 */
export function splitLabel(ratio: number): string {
  if (ratio < 1) return `${Math.round(1 / ratio)}:1 forward split`;
  return `1:${Math.round(ratio)} reverse split`;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function makeAudit(): SymbolAudit {
  return { status: 'clean', issues: [] };
}

function addError(
  audits: Map<string, SymbolAudit>,
  symbol: string,
  issue: Omit<Issue, 'severity'>,
): void {
  const a = audits.get(symbol) ?? makeAudit();
  a.status = 'error';
  a.issues.push({ ...issue, severity: 'error' });
  audits.set(symbol, a);
}

function addWarning(
  audits: Map<string, SymbolAudit>,
  symbol: string,
  issue: Omit<Issue, 'severity'>,
): void {
  const a = audits.get(symbol) ?? makeAudit();
  if (a.status === 'clean') a.status = 'warning';
  a.issues.push({ ...issue, severity: 'warning' });
  audits.set(symbol, a);
}

// ─── runAudit ─────────────────────────────────────────────────────────────────

/**
 * Runs all data-quality checks against the given pool.
 * Does NOT print, exit, or read from process.env — all behaviour is driven by config.
 */
export async function runAudit(
  pool: pg.Pool,
  config: AuditConfig,
): Promise<AuditReport> {
  const {
    startMs,
    endMs,
    multiplier,
    timespan,
    gapThreshold,
    crossSourceThreshold,
    splitTolerance,
    intradayGapMinutes,
  } = config;

  const expectsIntraday =
    timespan === 'minute' || timespan === 'second' || timespan === 'hour';

  const expectedDays = computeExpectedTradingDays(startMs, endMs);
  const startIso = new Date(startMs).toISOString();

  const audits = new Map<string, SymbolAudit>();

  // ─── Load universe ──────────────────────────────────────────────────────────

  const { rows: symbolRows } = await pool.query<{
    symbol: string;
    backfilled: boolean;
  }>('SELECT symbol, backfilled FROM universe_symbol ORDER BY symbol');

  const allSymbols = symbolRows.map((r) => r.symbol);
  for (const { symbol } of symbolRows) {
    audits.set(symbol, makeAudit());
  }

  for (const { symbol, backfilled } of symbolRows) {
    if (!backfilled) {
      addWarning(audits, symbol, {
        code: CODE.NOT_BACKFILLED,
        detail: {
          message: 'universe_symbol.backfilled = false; no bars expected yet',
        },
      });
    }
  }

  // ─── 1: Coverage ────────────────────────────────────────────────────────────

  const { rows: barDateRows } = await pool.query<{
    symbol: string;
    bar_date: string;
  }>(
    `SELECT symbol, (ts AT TIME ZONE 'UTC')::date::text AS bar_date
     FROM price_bar
     WHERE ts >= $1::timestamptz
     GROUP BY symbol, (ts AT TIME ZONE 'UTC')::date
     ORDER BY symbol, bar_date`,
    [startIso],
  );

  const symbolDates = new Map<string, Set<string>>();
  for (const row of barDateRows) {
    let s = symbolDates.get(row.symbol);
    if (!s) {
      s = new Set();
      symbolDates.set(row.symbol, s);
    }
    s.add(row.bar_date);
  }

  for (const { symbol, backfilled } of symbolRows) {
    if (!backfilled) continue;

    const presentDates = symbolDates.get(symbol) ?? new Set<string>();

    if (presentDates.size === 0) {
      addError(audits, symbol, {
        code: CODE.NO_BARS,
        detail: { expectedStart: new Date(startMs).toISOString().slice(0, 10) },
      });
      continue;
    }

    for (const gap of findCoverageGaps(
      expectedDays,
      presentDates,
      gapThreshold,
    )) {
      addError(audits, symbol, {
        code: CODE.COVERAGE_GAP,
        detail: gap,
      });
    }
  }

  // ─── 2: OHLC sanity ─────────────────────────────────────────────────────────

  const { rows: ohlcRows } = await pool.query<{
    symbol: string;
    violation_count: number;
    low_gt_open: number;
    low_gt_close: number;
    open_gt_high: number;
    close_gt_high: number;
    negative_volume: number;
  }>(
    `SELECT
       symbol,
       COUNT(*) AS violation_count,
       COUNT(*) FILTER (WHERE low > open)   AS low_gt_open,
       COUNT(*) FILTER (WHERE low > close)  AS low_gt_close,
       COUNT(*) FILTER (WHERE open > high)  AS open_gt_high,
       COUNT(*) FILTER (WHERE close > high) AS close_gt_high,
       COUNT(*) FILTER (WHERE volume IS NOT NULL AND volume < 0) AS negative_volume
     FROM price_bar
     WHERE low > open OR low > close OR open > high OR close > high
        OR (volume IS NOT NULL AND volume < 0)
     GROUP BY symbol
     ORDER BY symbol`,
  );

  for (const row of ohlcRows) {
    addError(audits, row.symbol, {
      code: CODE.OHLC_VIOLATION,
      detail: {
        violationCount: row.violation_count,
        lowGtOpen: row.low_gt_open,
        lowGtClose: row.low_gt_close,
        openGtHigh: row.open_gt_high,
        closeGtHigh: row.close_gt_high,
        negativeVolume: row.negative_volume,
      },
    });
  }

  // ─── 3: Duplicate detection ──────────────────────────────────────────────────

  const bucketExpr = buildBucketExpr(multiplier, timespan);

  const { rows: dupRows } = await pool.query<{
    symbol: string;
    duplicate_buckets: number;
    extra_bars: number;
  }>(
    `SELECT
       symbol,
       COUNT(*) AS duplicate_buckets,
       SUM(bucket_count - 1)::bigint AS extra_bars
     FROM (
       SELECT symbol, ${bucketExpr} AS bucket, COUNT(*) AS bucket_count
       FROM price_bar
       GROUP BY symbol, ${bucketExpr}
       HAVING COUNT(*) > 1
     ) sub
     GROUP BY symbol
     ORDER BY symbol`,
  );

  for (const row of dupRows) {
    addError(audits, row.symbol, {
      code: CODE.DUPLICATE_BAR,
      detail: {
        duplicateBuckets: row.duplicate_buckets,
        extraBars: row.extra_bars,
        granularity: `${multiplier} ${timespan}`,
      },
    });
  }

  // ─── 4: Cross-source reconciliation ─────────────────────────────────────────

  const { rows: crossRows } = await pool.query<{
    symbol: string;
    bar_date: string;
    daily_close: number;
    intraday_close: number;
    deviation: number;
  }>(
    `WITH daily_bars AS (
       SELECT symbol, ts::date AS bar_date, close
       FROM price_bar
       WHERE EXTRACT(hour   FROM ts AT TIME ZONE 'UTC') = 0
         AND EXTRACT(minute FROM ts AT TIME ZONE 'UTC') = 0
         AND EXTRACT(second FROM ts AT TIME ZONE 'UTC') = 0
     ),
     intraday_last AS (
       SELECT DISTINCT ON (symbol, ts::date)
         symbol, ts::date AS bar_date, close
       FROM price_bar
       WHERE NOT (
         EXTRACT(hour   FROM ts AT TIME ZONE 'UTC') = 0
         AND EXTRACT(minute FROM ts AT TIME ZONE 'UTC') = 0
         AND EXTRACT(second FROM ts AT TIME ZONE 'UTC') = 0
       )
       ORDER BY symbol, ts::date, ts DESC
     )
     SELECT
       d.symbol,
       d.bar_date::text                                         AS bar_date,
       d.close                                                  AS daily_close,
       i.close                                                  AS intraday_close,
       ABS(d.close::double precision - i.close::double precision)
         / NULLIF(d.close::double precision, 0)                AS deviation
     FROM daily_bars d
     JOIN intraday_last i ON d.symbol = i.symbol AND d.bar_date = i.bar_date
     WHERE ABS(d.close::double precision - i.close::double precision)
           / NULLIF(d.close::double precision, 0) > $1
     ORDER BY d.symbol, deviation DESC
     LIMIT 500`,
    [crossSourceThreshold],
  );

  const crossBySymbol = new Map<string, typeof crossRows>();
  for (const row of crossRows) {
    let arr = crossBySymbol.get(row.symbol);
    if (!arr) {
      arr = [];
      crossBySymbol.set(row.symbol, arr);
    }
    arr.push(row);
  }

  for (const [symbol, deviations] of crossBySymbol) {
    addError(audits, symbol, {
      code: CODE.CROSS_SOURCE_DEVIATION,
      detail: {
        deviatingDates: deviations.length,
        maxDeviation: deviations[0]?.deviation,
        samples: deviations.slice(0, 5).map((r) => ({
          date: r.bar_date,
          dailyClose: r.daily_close,
          intradayClose: r.intraday_close,
          deviation: r.deviation,
        })),
      },
    });
  }

  // ─── 5: Intraday gap detection ───────────────────────────────────────────────

  if (expectsIntraday) {
    // A: symbols with NO session-hour bars — data is likely daily-only.
    const { rows: noSessionRows } = await pool.query<{
      symbol: string;
      bar_count: number;
    }>(
      `SELECT symbol, COUNT(*) AS bar_count
       FROM price_bar
       WHERE ts >= $1::timestamptz
       GROUP BY symbol
       HAVING SUM(CASE WHEN
         EXTRACT(hour FROM ts AT TIME ZONE 'UTC') BETWEEN 13 AND 22
         THEN 1 ELSE 0 END) = 0
         AND COUNT(*) > 0
       ORDER BY symbol`,
      [startIso],
    );

    for (const row of noSessionRows) {
      const meta = symbolRows.find((r) => r.symbol === row.symbol);
      if (meta && !meta.backfilled) continue;
      addError(audits, row.symbol, {
        code: CODE.INTRADAY_GAP,
        detail: {
          type: 'no_session_bars',
          barCount: row.bar_count,
          note: `All ${row.bar_count} bars are outside market session hours (13:00–22:00 UTC). Expected ${multiplier}-${timespan} intraday data but corpus appears to be daily-only.`,
        },
      });
    }

    // B: symbols with session bars but consecutive within-session gap > threshold.
    const { rows: sessionGapRows } = await pool.query<{
      symbol: string;
      gap_count: number;
      max_gap_minutes: number;
    }>(
      `WITH session_bars AS (
         SELECT symbol, ts
         FROM price_bar
         WHERE ts >= $1::timestamptz
           AND EXTRACT(hour FROM ts AT TIME ZONE 'UTC') BETWEEN 13 AND 22
       ),
       consecutive AS (
         SELECT
           symbol,
           EXTRACT(EPOCH FROM (
             LEAD(ts) OVER (
               PARTITION BY symbol, (ts AT TIME ZONE 'UTC')::date
               ORDER BY ts
             ) - ts
           )) / 60 AS gap_minutes
         FROM session_bars
       )
       SELECT symbol, COUNT(*) AS gap_count, MAX(gap_minutes)::double precision AS max_gap_minutes
       FROM consecutive
       WHERE gap_minutes > $2
       GROUP BY symbol
       ORDER BY symbol`,
      [startIso, intradayGapMinutes],
    );

    for (const row of sessionGapRows) {
      addError(audits, row.symbol, {
        code: CODE.INTRADAY_GAP,
        detail: {
          type: 'session_gap',
          gapCount: row.gap_count,
          maxGapMinutes: Math.round(row.max_gap_minutes),
          thresholdMinutes: intradayGapMinutes,
        },
      });
    }
  }

  // ─── 6: Split / reverse-split candidates ────────────────────────────────────

  const splitFactors = [0.5, 1 / 3, 0.25, 0.2, 0.1, 2.0, 3.0, 5.0, 10.0];
  const splitClauses = splitFactors
    .map(
      (f) =>
        `(ratio BETWEEN ${f - f * splitTolerance} AND ${f + f * splitTolerance})`,
    )
    .join(' OR ');

  const { rows: splitRows } = await pool.query<{
    symbol: string;
    bar_date: string;
    old_close: number;
    new_close: number;
    ratio: number;
  }>(
    `WITH daily_last AS (
       SELECT DISTINCT ON (symbol, (ts AT TIME ZONE 'UTC')::date)
         symbol,
         (ts AT TIME ZONE 'UTC')::date AS bar_date,
         close
       FROM price_bar
       ORDER BY symbol, (ts AT TIME ZONE 'UTC')::date, ts DESC
     ),
     with_ratio AS (
       SELECT
         symbol,
         bar_date::text,
         close                                                          AS new_close,
         LAG(close) OVER (PARTITION BY symbol ORDER BY bar_date)       AS old_close,
         (close::double precision /
           NULLIF(LAG(close) OVER (PARTITION BY symbol ORDER BY bar_date)
                  ::double precision, 0))                              AS ratio
       FROM daily_last
     )
     SELECT symbol, bar_date, old_close, new_close, ratio
     FROM with_ratio
     WHERE old_close IS NOT NULL
       AND old_close > 0
       AND (${splitClauses})
     ORDER BY symbol, bar_date
     LIMIT 1000`,
  );

  const splitBySymbol = new Map<string, typeof splitRows>();
  for (const row of splitRows) {
    let arr = splitBySymbol.get(row.symbol);
    if (!arr) {
      arr = [];
      splitBySymbol.set(row.symbol, arr);
    }
    arr.push(row);
  }

  for (const [symbol, splits] of splitBySymbol) {
    addWarning(audits, symbol, {
      code: CODE.SPLIT_CANDIDATE,
      detail: {
        candidates: splits.length,
        events: splits.map((r) => ({
          date: r.bar_date,
          oldClose: r.old_close,
          newClose: r.new_close,
          ratio: Math.round(r.ratio * 10000) / 10000,
          likelySplit: splitLabel(r.ratio),
        })),
        note: 'v1 uses raw prices; verify whether the data source returns adjusted or unadjusted bars. If unadjusted, positions must be corrected on the split date and adj_close support added in v2.',
      },
    });
  }

  // ─── Build report ────────────────────────────────────────────────────────────

  const errorCounts: Record<ErrorCode, number> = {
    NO_BARS: 0,
    COVERAGE_GAP: 0,
    OHLC_VIOLATION: 0,
    DUPLICATE_BAR: 0,
    CROSS_SOURCE_DEVIATION: 0,
    INTRADAY_GAP: 0,
    NOT_BACKFILLED: 0,
    SPLIT_CANDIDATE: 0,
  };

  let symbolsClean = 0;
  let symbolsWithWarnings = 0;
  let symbolsWithErrors = 0;

  for (const audit of audits.values()) {
    if (audit.status === 'clean') symbolsClean++;
    else if (audit.status === 'warning') symbolsWithWarnings++;
    else symbolsWithErrors++;

    for (const issue of audit.issues) {
      errorCounts[issue.code]++;
    }
  }

  const flaggedSymbols: Record<string, SymbolAudit> = {};
  for (const [sym, audit] of audits) {
    if (audit.issues.length > 0) flaggedSymbols[sym] = audit;
  }

  return {
    runAt: new Date().toISOString(),
    config: {
      expectedStartDate: new Date(startMs).toISOString().slice(0, 10),
      gapThresholdDays: gapThreshold,
      crossSourceThreshold,
      granularity: `${multiplier} ${timespan}`,
    },
    summary: {
      totalSymbols: allSymbols.length,
      symbolsClean,
      symbolsWithWarnings,
      symbolsWithErrors,
    },
    errorCounts,
    symbols: flaggedSymbols,
  };
}
