import { pool } from '../db/pool.js';
import { resolveStartMs } from './backfill.js';

// Tolerance (days) for non-trading days at the window boundary. A symbol whose
// earliest stored bar is only a few days after the requested start (because the
// start landed on a weekend or holiday stretch) is treated as fully covered, so
// ordinary re-runs don't needlessly re-arm everything. The longest run of
// consecutive market closures (holiday + weekend) is ~4 days; 7 is a safe pad.
const GAP_THRESHOLD_DAYS = parseInt(
  process.env['BACKFILL_GAP_THRESHOLD_DAYS'] ?? '7',
  10,
);

function log(level: 'info', msg: string, extra?: object): void {
  console[level](
    JSON.stringify({ level, component: 'widen-history', msg, ...extra }),
  );
}

// Script-only widen-history step (run from `pnpm backfill`, never the worker).
//
// When the requested start date reaches further back than a symbol's oldest
// stored bar — by more than the weekend/holiday tolerance — flip that symbol
// back to backfilled = false so runBackfill re-fetches the now-missing earlier
// history. This is a deliberate, data-derived, one-shot decision: the worker
// keeps the simple boolean and never re-derives coverage on boot.
//
// Caveat (the cost of not persisting a coverage watermark): a symbol whose real
// history is shorter than the window — e.g. a recent IPO with no data that far
// back — has a permanent apparent "gap", so each explicit re-run with the same
// wide date re-arms it and re-fetches an empty earlier range. That waste is
// bounded to such symbols and only on runs where you deliberately widen.
export async function resetSymbolsMissingHistory(
  startMs: number = resolveStartMs(),
): Promise<number> {
  const requestedStart = new Date(startMs).toISOString();
  const { rows } = await pool.query<{ symbol: string }>(
    `UPDATE universe_symbol u
        SET backfilled = false
       FROM (
         SELECT symbol, MIN(ts) AS oldest
           FROM price_bar
          GROUP BY symbol
       ) cov
      WHERE u.symbol = cov.symbol
        AND u.backfilled = true
        AND cov.oldest > $1::timestamptz + ($2::int * interval '1 day')
      RETURNING u.symbol`,
    [requestedStart, GAP_THRESHOLD_DAYS],
  );

  if (rows.length > 0) {
    log('info', 're-armed symbols with missing earlier history', {
      requestedStart: requestedStart.slice(0, 10),
      thresholdDays: GAP_THRESHOLD_DAYS,
      reset: rows.length,
      symbols: rows.map((r) => r.symbol),
    });
  } else {
    log('info', 'no symbols need widening', {
      requestedStart: requestedStart.slice(0, 10),
    });
  }

  return rows.length;
}
