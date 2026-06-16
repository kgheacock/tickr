import type { Redis } from 'ioredis';
import { pool } from '../db/pool.js';
// Import the client directly (not finnhub/index.js) so loading this job never
// trips the worker-only role guard — mirrors how intraday-update imports
// massive/client.js. The guard lives in finnhub/index.js and is tested there;
// in practice this job is only ever registered from the worker role.
import { finnhubGet } from '../finnhub/client.js';
import type { components } from '../finnhub/finnhub.gen.js';
import { mostRecentSessionDate } from '../market/holidays.js';
import { jobLogger } from '../log/logger.js';

const baseLog = jobLogger('close-capture');

type Quote = components['schemas']['Quote'];

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  baseLog[level](extra ?? {}, msg);
}

/**
 * Post-close capture of each playable symbol's official regular-session close
 * from Finnhub /quote, persisted to the provisional `session_close` store
 * (TODO/30). After 16:00 ET, Finnhub's `c` holds the frozen official close, so a
 * post-close sweep can supply each trading day's close hours-to-days before
 * Massive's free-tier 15-min bars backfill it (Massive serves a session's bars
 * only the next trading day, and never on weekends — so Friday's don't land
 * until Monday). Day-agnostic by construction: it keys on mostRecentSessionDate,
 * so the same sweep serves the daily cron for any session (see scheduler.ts).
 *
 * `session_close` and `price_bar` are two PARALLEL stores, joinable later if
 * needed but never merged here: this writes only session_close, and deliberately
 * does NOT touch `price_bar`/insertBars — that store stays Massive-pure (15-min
 * authoritative bars) so backtests and charts never see provisional same-day
 * data. When Massive's bar for a session lands, both rows coexist; nothing here
 * overwrites either.
 *
 * Runs after each trading day's close under a Redis lock (see scheduler.ts). Each
 * symbol goes through the Finnhub token bucket; at 60/min a ~502-symbol sweep is
 * ~9 min.
 */
export async function runCloseCapture(redis: Redis): Promise<void> {
  // The just-closed session, holiday-aware (a holiday Friday keys to the prior
  // trading day, which is exactly the close the weekly scorer still needs).
  const sessionDate = mostRecentSessionDate(new Date());

  const { rows } = await pool.query<{ symbol: string }>(
    // Same playable corpus as runIntradayUpdate (loadUniverse): skip removed and
    // depth-capped ('incomplete') symbols so we don't spend Finnhub budget on
    // symbols the platform doesn't surface.
    `SELECT symbol FROM universe_symbol
      WHERE backfilled = true
        AND removed_at IS NULL
        AND data_status IS DISTINCT FROM 'incomplete'
      ORDER BY symbol`,
  );

  if (rows.length === 0) {
    log('info', 'no playable symbols — skipping', { sessionDate });
    return;
  }

  log('info', 'starting close capture', {
    symbols: rows.length,
    sessionDate,
  });

  let captured = 0;
  let skipped = 0;
  let failed = 0;

  for (const { symbol } of rows) {
    let quote: Quote;
    try {
      quote = await finnhubGet<Quote>(redis, '/quote', { symbol });
    } catch (err) {
      // A single symbol's failure must not abort the whole sweep — the scorer's
      // COALESCE falls back to authoritative bars per symbol anyway.
      failed++;
      log('warn', 'quote fetch failed — skipping symbol', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const c = quote.c;
    if (typeof c !== 'number' || !(c > 0)) {
      // Finnhub returns c:0 for an unknown/halted symbol; never persist that.
      skipped++;
      continue;
    }

    const close = Math.round(c * 100);
    await pool.query(
      // Idempotent: re-running the sweep refreshes the provisional close and its
      // capture time. Keyed by (symbol, session_date), so it never collides with
      // the authoritative price_bar row (keyed by ts).
      `INSERT INTO session_close (symbol, session_date, close, source)
         VALUES ($1, $2, $3, 'finnhub')
       ON CONFLICT (symbol, session_date)
         DO UPDATE SET close = EXCLUDED.close, captured_at = now()`,
      [symbol, sessionDate, close],
    );
    captured++;
  }

  log('info', 'close capture complete', {
    sessionDate,
    captured,
    skipped,
    failed,
  });
}
