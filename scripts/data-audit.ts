#!/usr/bin/env tsx
/**
 * Pre-deploy data audit for the price_bar corpus.
 *
 * Checks (each has its own error code):
 *   NO_BARS               - symbol has zero price_bar rows in the expected window
 *   COVERAGE_GAP          - >= GAP_THRESHOLD consecutive trading days missing
 *   OHLC_VIOLATION        - low > open/close, open/close > high, or volume < 0
 *   DUPLICATE_BAR         - > 1 bar in a single granularity bucket (symbol, bucket)
 *   CROSS_SOURCE_DEVIATION - daily-bar close and intraday-bar close diverge > threshold
 *   INTRADAY_GAP          - gap > INTRADAY_GAP_MINUTES between consecutive within-session
 *                           bars, OR no session-hour bars at all (e.g. only daily data)
 *
 * Warnings (informational, do not cause a non-zero exit):
 *   NOT_BACKFILLED        - symbol in universe_symbol with backfilled = false
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
 *   AUDIT_CROSS_SOURCE_THRESHOLD     default 0.01 — fractional close deviation to flag
 *   AUDIT_SPLIT_TOLERANCE            default 0.03 — tolerance around known split ratios
 *   AUDIT_INTRADAY_GAP_MINUTES       default 30 — max gap (minutes) allowed between
 *                                    consecutive within-session bars (skipped for day/week/month)
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
    crossSourceThreshold: parseFloat(
      process.env['AUDIT_CROSS_SOURCE_THRESHOLD'] ?? '0.01',
    ),
    splitTolerance: parseFloat(process.env['AUDIT_SPLIT_TOLERANCE'] ?? '0.03'),
    intradayGapMinutes: parseInt(
      process.env['AUDIT_INTRADAY_GAP_MINUTES'] ?? '30',
      10,
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
