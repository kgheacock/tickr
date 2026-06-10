import type pg from 'pg';
import { isNyseHoliday } from '../market/holidays.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export const CODE = {
  NO_BARS: 'NO_BARS',
  COVERAGE_GAP: 'COVERAGE_GAP',
  OHLC_VIOLATION: 'OHLC_VIOLATION',
  DUPLICATE_BAR: 'DUPLICATE_BAR',
  INTRADAY_GAP: 'INTRADAY_GAP',
  NOT_BACKFILLED: 'NOT_BACKFILLED',
  EXCLUDED: 'EXCLUDED',
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
  /** Fractional tolerance around known split ratios. */
  splitTolerance: number;
  /** Max gap (minutes) between consecutive within-session bars. */
  intradayGapMinutes: number;
  /**
   * NYSE regular-session open, as an ET wall-clock time (HH:MM). Bars are
   * filtered to [open, close) in America/New_York so the gap check never
   * reaches into the sparse pre/post-market zone (the source returns irregular
   * extended-hours bars that are not real coverage gaps). DST-correct because
   * the comparison is done after converting ts to ET. Defaults to 09:30.
   */
  sessionOpenEt: string;
  /** NYSE regular-session close as an ET wall-clock time (HH:MM). Defaults to 16:00. */
  sessionCloseEt: string;
}

export interface AuditReport {
  runAt: string;
  config: {
    expectedStartDate: string;
    gapThresholdDays: number;
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

/**
 * Where a gap sits in the expected window. This drives severity (see runAudit
 * coverage check):
 *   - `leading` — the symbol's history simply starts after the window start.
 *     For a multi-year window this is almost always a listing/IPO after the
 *     window opened (e.g. EXE/Expand Energy, formed Oct 2024); the pre-listing
 *     data does not exist and cannot be fetched. Benign → **warning**.
 *   - `internal` — a hole in the middle of otherwise-present history. Real data
 *     loss/corruption → **error**.
 *   - `trailing` — the symbol stops before the window end. On a playable
 *     (`backfilled = true`, not `data_status = 'incomplete'`) symbol this means
 *     ingestion stalled near now → **error**. Delisted/depth-capped symbols are
 *     marked `incomplete` and skipped before this check, so they never reach it.
 * See docs/12-data-remediation-plan.md (Findings 2A vs 2B/2C).
 */
export type GapPosition = 'leading' | 'internal' | 'trailing';

// A type alias (not an interface) so it stays assignable to the Issue.detail
// `Record<string, unknown>` — named interfaces lack an implicit index signature.
export type CoverageGap = {
  gapStart: string;
  gapEnd: string;
  missingTradingDays: number;
  position: GapPosition;
};

/** Finds runs of missing trading days >= gapThreshold in length. */
export function findCoverageGaps(
  expectedDays: string[],
  presentDates: Set<string>,
  gapThreshold: number,
): CoverageGap[] {
  const firstDay = expectedDays[0];
  const lastDay = expectedDays[expectedDays.length - 1];
  const classify = (start: string, end: string): GapPosition => {
    if (end === lastDay) return 'trailing';
    if (start === firstDay) return 'leading';
    return 'internal';
  };

  const gaps: CoverageGap[] = [];
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
        gaps.push({
          gapStart,
          gapEnd,
          missingTradingDays: gapCount,
          position: classify(gapStart, gapEnd),
        });
      }
      gapStart = null;
      gapEnd = null;
      gapCount = 0;
    }
  }
  if (gapCount >= gapThreshold && gapStart !== null && gapEnd !== null) {
    gaps.push({
      gapStart,
      gapEnd,
      missingTradingDays: gapCount,
      position: classify(gapStart, gapEnd),
    });
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
    splitTolerance,
    intradayGapMinutes,
    sessionOpenEt,
    sessionCloseEt,
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
    data_status: string | null;
  }>(
    'SELECT symbol, backfilled, data_status FROM universe_symbol ORDER BY symbol',
  );

  const allSymbols = symbolRows.map((r) => r.symbol);
  for (const { symbol } of symbolRows) {
    audits.set(symbol, makeAudit());
  }

  // The "playable" corpus is what the product actually serves. Every hard
  // data-quality check below runs ONLY against these symbols, so universe churn
  // (a symbol that hasn't been backfilled yet, or a delisted/depth-capped one
  // marked data_status='incomplete' — see migration ...005 and TODO/12) never
  // blocks a deploy. Excluded symbols still surface as warnings so they stay
  // visible in the report.
  const playable = new Set<string>();
  for (const { symbol, backfilled, data_status } of symbolRows) {
    if (!backfilled) {
      addWarning(audits, symbol, {
        code: CODE.NOT_BACKFILLED,
        detail: {
          message: 'universe_symbol.backfilled = false; no bars expected yet',
        },
      });
      continue;
    }
    if (data_status === 'incomplete') {
      addWarning(audits, symbol, {
        code: CODE.EXCLUDED,
        detail: {
          message:
            "data_status = 'incomplete' — delisted/depth-capped, excluded " +
            'from the playable corpus; data-quality checks are skipped',
        },
      });
      continue;
    }
    playable.add(symbol);
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

  for (const { symbol } of symbolRows) {
    if (!playable.has(symbol)) continue;

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
      // A leading gap is a late listing (pre-listing data can't be fetched) —
      // benign, warn only. Internal/trailing gaps are real missing data on a
      // live symbol — error. See the GapPosition doc above.
      const issue = { code: CODE.COVERAGE_GAP, detail: gap };
      if (gap.position === 'leading') addWarning(audits, symbol, issue);
      else addError(audits, symbol, issue);
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
    if (!playable.has(row.symbol)) continue;
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
    if (!playable.has(row.symbol)) continue;
    addError(audits, row.symbol, {
      code: CODE.DUPLICATE_BAR,
      detail: {
        duplicateBuckets: row.duplicate_buckets,
        extraBars: row.extra_bars,
        granularity: `${multiplier} ${timespan}`,
      },
    });
  }

  // ─── 4: (removed) Cross-source reconciliation ───────────────────────────────
  //
  // This check used to compare a "daily" close against the day's "intraday"
  // close, keying "daily bars" off ts being exactly 00:00:00 UTC. That premise
  // does not hold for this corpus: we ingest a single granularity (15-minute
  // bars, BACKFILL_TIMESPAN=minute) — there is no separate daily/EOD source.
  // A bar at 00:00:00 UTC is just the 15-min grid bar that landed on midnight
  // UTC = 19:00 ET, i.e. a thin post-market print from the PREVIOUS ET session.
  // So the check compared two different trading days' prices and flagged every
  // volatile name with a multi-percent "deviation" (49 symbols on prod, all
  // false positives — daily[D] consistently equalled the real intraday close of
  // D-1). Removed rather than retuned: it cannot be made correct without a
  // genuine second price source. Re-introduce only if a real daily/EOD feed is
  // ingested alongside the intraday bars.

  // ─── 5: Intraday gap detection ───────────────────────────────────────────────

  if (expectsIntraday) {
    // Regular-session window, expressed in ET so the comparison is DST-correct
    // (the UTC offset of 09:30 ET differs by ±1h across the year). Filtering to
    // [open, close) excludes the sparse pre/post-market bars the source returns
    // at irregular intervals, which are NOT real intraday gaps. See
    // docs/12-data-remediation-plan.md (Finding 1).
    const etTime = `(ts AT TIME ZONE 'America/New_York')::time`;

    // A: symbols with NO regular-session bars — data is likely daily-only.
    const { rows: noSessionRows } = await pool.query<{
      symbol: string;
      bar_count: number;
    }>(
      `SELECT symbol, COUNT(*) AS bar_count
       FROM price_bar
       WHERE ts >= $1::timestamptz
       GROUP BY symbol
       HAVING SUM(CASE WHEN
         ${etTime} >= $2::time AND ${etTime} < $3::time
         THEN 1 ELSE 0 END) = 0
         AND COUNT(*) > 0
       ORDER BY symbol`,
      [startIso, sessionOpenEt, sessionCloseEt],
    );

    for (const row of noSessionRows) {
      if (!playable.has(row.symbol)) continue;
      // Hard error: a playable symbol with bars but NONE in the regular session
      // means we have no usable intraday data for it (e.g. daily-only corpus).
      addError(audits, row.symbol, {
        code: CODE.INTRADAY_GAP,
        detail: {
          type: 'no_session_bars',
          barCount: row.bar_count,
          note: `All ${row.bar_count} bars are outside the NYSE regular session (${sessionOpenEt}–${sessionCloseEt} ET). Expected ${multiplier}-${timespan} intraday data but corpus appears to be daily-only.`,
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
           AND ${etTime} >= $3::time AND ${etTime} < $4::time
       ),
       consecutive AS (
         SELECT
           symbol,
           EXTRACT(EPOCH FROM (
             LEAD(ts) OVER (
               PARTITION BY symbol, (ts AT TIME ZONE 'America/New_York')::date
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
      [startIso, intradayGapMinutes, sessionOpenEt, sessionCloseEt],
    );

    for (const row of sessionGapRows) {
      if (!playable.has(row.symbol)) continue;
      // Warning, not error: a within-session gap is data sparsity, not
      // corruption. Thin/high-priced names (ERIE, AZO, GWW, BKNG…) genuinely
      // don't trade in every 15-min window, and re-backfilling can't conjure
      // trades that never happened — so this must not block a deploy. Kept
      // visible as a warning so a sudden jump in gaps is still noticeable.
      addWarning(audits, row.symbol, {
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
    if (!playable.has(symbol)) continue;
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
        note: 'Massive /v2/aggs returns split-adjusted prices by default (the backfill does not pass adjusted=false), so a true split should NOT appear as a step here. A candidate is therefore most likely a genuine large single-day move (false positive at this tolerance) or a data error — verify against known corporate actions before acting. See docs/12-data-remediation-plan.md (Finding 5).',
      },
    });
  }

  // ─── Build report ────────────────────────────────────────────────────────────

  const errorCounts: Record<ErrorCode, number> = {
    NO_BARS: 0,
    COVERAGE_GAP: 0,
    OHLC_VIOLATION: 0,
    DUPLICATE_BAR: 0,
    INTRADAY_GAP: 0,
    NOT_BACKFILLED: 0,
    EXCLUDED: 0,
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
