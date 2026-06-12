#!/usr/bin/env tsx
/**
 * Pre-deploy data audit for the price_bar corpus.
 *
 * All checks run only against the "playable" corpus: symbols with
 * backfilled = true and data_status <> 'incomplete'. Symbols not yet backfilled
 * or marked incomplete (delisted/depth-capped) are reported as warnings and
 * skipped, so universe churn never blocks a deploy.
 *
 * Errors (cause a non-zero exit / block the deploy):
 *   NO_BARS               - playable symbol has zero price_bar rows in the window
 *   COVERAGE_GAP          - >= GAP_THRESHOLD consecutive trading days missing, in an
 *                           internal or trailing position (a leading gap is a late
 *                           listing and is reported as a warning instead)
 *   COVERAGE_REGRESSION   - a symbol's covered/expected ratio dropped below its
 *                           recorded high-water-mark (symbol_coverage_watermark) by
 *                           more than AUDIT_WATERMARK_TOLERANCE — likely data loss,
 *                           even when scattered (so it slips under COVERAGE_GAP's
 *                           consecutive-day threshold). A true rename does not
 *                           regress. Reset an intentional, permanent drop by hand:
 *                           DELETE FROM symbol_coverage_watermark WHERE symbol='X'.
 *   OHLC_VIOLATION        - low > open/close, open/close > high, or volume < 0
 *   DUPLICATE_BAR         - > 1 bar in a single granularity bucket (symbol, bucket)
 *   INTRADAY_GAP          - (type 'no_session_bars') a playable symbol has bars but none
 *                           inside the NYSE regular session (09:30–16:00 ET) — no usable
 *                           intraday data
 *
 * Warnings (informational, do not cause a non-zero exit):
 *   NOT_BACKFILLED        - symbol in universe_symbol with backfilled = false
 *   EXCLUDED              - data_status = 'incomplete' (delisted/depth-capped); excluded
 *                           from the playable corpus, checks skipped
 *   COVERAGE_GAP          - leading gap (history starts late — typically a listing/IPO)
 *   INTRADAY_GAP          - (type 'session_gap') sparse within-session coverage on a
 *                           thinly-traded name; data sparsity, not corruption
 *   SPLIT_CANDIDATE       - consecutive-day close ratio matches a common split factor
 *                           (e.g. ~0.5 for 2:1 forward split, ~2.0 for 1:2 reverse split).
 *                           v1 uses raw (non-adjusted) prices — splits are NOT corrected
 *                           automatically. Confirm whether the Massive API returns adjusted
 *                           or unadjusted prices; if unadjusted, queue a manual adj_close
 *                           migration or retroactive position-quantity correction for v2.
 *
 * Usage (from repo root):
 *   pnpm tsx scripts/data-audit.ts
 *
 * Environment (or .env at repo root):
 *   DATABASE_URL                     required
 *   BACKFILL_LOOKBACK_DAYS           default 730 — expected coverage window
 *   BACKFILL_START_DATE              overrides LOOKBACK_DAYS if set
 *   BACKFILL_MULTIPLIER              default 15 — bar granularity multiplier
 *   BACKFILL_TIMESPAN                default 'minute' — bar granularity unit
 *   AUDIT_GAP_THRESHOLD              default 5 — consecutive missing trading days to flag as error
 *   AUDIT_SPLIT_TOLERANCE            default 0.03 — tolerance around known split ratios
 *   AUDIT_INTRADAY_GAP_MINUTES       default 30 — max gap (minutes) allowed between
 *                                    consecutive within-session bars (skipped for day/week/month)
 *   AUDIT_SESSION_OPEN_ET            default 09:30 — NYSE regular-session open (ET wall-clock)
 *   AUDIT_SESSION_CLOSE_ET           default 16:00 — NYSE regular-session close (ET wall-clock)
 *   AUDIT_WATERMARK_TOLERANCE        default 0.02 — fractional coverage-ratio drop below a
 *                                    symbol's high-water-mark tolerated before COVERAGE_REGRESSION
 *
 * Exits 0 on a clean corpus (errors = 0), non-zero if any errors are found.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(20, Number);
pg.types.setTypeParser(1700, parseFloat);

// Load .env from repo root before any import that reads env vars.
if (!process.env['DATABASE_URL']) {
  try {
    for (const line of readFileSync(
      resolve(process.cwd(), '.env'),
      'utf8',
    ).split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) {
        const [, key, val] = match;
        process.env[key!] ??= val!.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // no .env — rely on environment
  }
}

process.env['ROLE'] ??= 'script';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOOKBACK_DAYS = parseInt(
  process.env['BACKFILL_LOOKBACK_DAYS'] ?? '730',
  10,
);
const BACKFILL_START_DATE = process.env['BACKFILL_START_DATE'];
const VALID_TIMESPANS = [
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;
const TIMESPAN = process.env['BACKFILL_TIMESPAN'] ?? 'minute';
if (!(VALID_TIMESPANS as readonly string[]).includes(TIMESPAN)) {
  console.error(`Invalid BACKFILL_TIMESPAN: ${TIMESPAN}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { requireEnv } = await import('../apps/api/src/config.js');
  requireEnv('DATABASE_URL');

  const { runAudit } = await import('../apps/api/src/audit/run-audit.js');

  const nowMs = Date.now();
  const startMs = BACKFILL_START_DATE
    ? new Date(BACKFILL_START_DATE).getTime()
    : nowMs - LOOKBACK_DAYS * DAY_MS;

  const config = {
    startMs,
    endMs: nowMs - DAY_MS,
    multiplier: parseInt(process.env['BACKFILL_MULTIPLIER'] ?? '15', 10),
    timespan: TIMESPAN,
    gapThreshold: parseInt(process.env['AUDIT_GAP_THRESHOLD'] ?? '5', 10),
    splitTolerance: parseFloat(process.env['AUDIT_SPLIT_TOLERANCE'] ?? '0.03'),
    intradayGapMinutes: parseInt(
      process.env['AUDIT_INTRADAY_GAP_MINUTES'] ?? '30',
      10,
    ),
    sessionOpenEt: process.env['AUDIT_SESSION_OPEN_ET'] ?? '09:30',
    sessionCloseEt: process.env['AUDIT_SESSION_CLOSE_ET'] ?? '16:00',
    watermarkTolerance: parseFloat(
      process.env['AUDIT_WATERMARK_TOLERANCE'] ?? '0.02',
    ),
  };

  const pool = new pg.Pool({
    connectionString: process.env['DATABASE_URL'],
    max: 3,
  });

  console.error(
    `[data-audit] start — expected window: ` +
      `${new Date(config.startMs).toISOString().slice(0, 10)} → ` +
      `${new Date(config.endMs).toISOString().slice(0, 10)}`,
  );
  const report = await runAudit(pool, config);

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');

  console.error('\n=== DATA AUDIT SUMMARY ===');
  console.error(`Run at:               ${report.runAt}`);
  console.error(`Expected start:       ${report.config.expectedStartDate}`);
  console.error(`Granularity:          ${report.config.granularity}`);
  console.error(
    `Gap threshold:        ${report.config.gapThresholdDays} trading days`,
  );
  console.error(`Total symbols:        ${report.summary.totalSymbols}`);
  console.error(`Clean:                ${report.summary.symbolsClean}`);
  console.error(`Warnings:             ${report.summary.symbolsWithWarnings}`);
  console.error(`Errors:               ${report.summary.symbolsWithErrors}`);

  const activeErrorCodes = Object.entries(report.errorCounts).filter(
    ([, n]) => n > 0,
  );
  if (activeErrorCodes.length > 0) {
    console.error('\nError/warning counts by code:');
    for (const [code, n] of activeErrorCodes) {
      console.error(`  ${code.padEnd(26)} ${n}`);
    }
  }

  await pool.end();

  if (report.summary.symbolsWithErrors > 0) {
    console.error(
      `\n[data-audit] FAIL — ${report.summary.symbolsWithErrors} symbol(s) with errors. ` +
        'Resolve before deploying.\n',
    );
    process.exit(1);
  }

  console.error('\n[data-audit] PASS — corpus is clean.\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
