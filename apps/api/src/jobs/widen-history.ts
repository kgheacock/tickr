import { pool } from '../db/pool.js';
import { resolveStartMs } from './backfill.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Tolerance (days) for non-trading days at the window boundary. A symbol whose
// earliest stored bar is only a few days after the requested start (because the
// start landed on a weekend or holiday stretch) is treated as fully covered, so
// ordinary re-runs don't needlessly re-arm everything. The longest run of
// consecutive market closures (holiday + weekend) is ~4 days; 7 is a safe pad.
const GAP_THRESHOLD_DAYS = parseInt(
  process.env['BACKFILL_GAP_THRESHOLD_DAYS'] ?? '7',
  10,
);

// A backfilled symbol whose NEWEST bar is older than this many days has a stale
// tail: either it stopped updating (one-year-only / near-zero-coverage symbols,
// audit Findings 2B/2C) or the backfill never reached the present. Re-arm it so
// the next run re-fetches to now. Same weekend/holiday pad as the leading edge.
const STALE_TAIL_DAYS = parseInt(
  process.env['BACKFILL_STALE_TAIL_DAYS'] ?? '7',
  10,
);

function log(level: 'info', msg: string, extra?: object): void {
  console[level](
    JSON.stringify({ level, component: 'widen-history', msg, ...extra }),
  );
}

// Script-only widen-history step (run from `pnpm backfill`, never the worker).
//
// Flip a backfilled symbol back to backfilled = false so runBackfill re-fetches
// it, when its stored coverage falls short of the requested window in any of:
//   • no bars at all          — wrong ticker / delisted (audit Finding 4); a
//                               LEFT JOIN is required to see these (they have no
//                               price_bar rows to inner-join against)
//   • oldest bar too late      — missing earlier history (a widened start date)
//   • newest bar too old       — stale tail: one-year-only / near-zero-coverage
//                               symbols (audit Findings 2B/2C)
//
// data_status = 'incomplete' is the terminal mark the backfill sets when a
// symbol was attempted and the source genuinely has no recent data. Excluding it
// here is what makes the bootstrap CONVERGE: without it a depth-capped symbol
// would be re-armed → re-fetched (same short data) → re-armed forever.
//
// This is a deliberate, data-derived, one-shot decision: the worker keeps the
// simple boolean and never re-derives coverage on boot.
//
// Caveat (the cost of not persisting a coverage watermark): a symbol whose real
// history is shorter than the window re-fetches an empty earlier range on each
// widen — bounded waste. The 'incomplete' mark caps it once the backfill has
// confirmed the short tail.
export async function resetSymbolsMissingHistory(
  startMs: number = resolveStartMs(),
  nowMs: number = Date.now(),
): Promise<number> {
  const requestedStart = new Date(startMs).toISOString();
  const staleCutoff = new Date(nowMs - STALE_TAIL_DAYS * DAY_MS).toISOString();
  const { rows } = await pool.query<{ symbol: string }>(
    `UPDATE universe_symbol u
        SET backfilled = false
       FROM (
         SELECT us.symbol,
                MIN(pb.ts) AS oldest,
                MAX(pb.ts) AS newest,
                COUNT(pb.ts) AS bars
           FROM universe_symbol us
           LEFT JOIN price_bar pb ON pb.symbol = us.symbol
          WHERE us.backfilled = true
            AND us.removed_at IS NULL
            AND us.data_status IS DISTINCT FROM 'incomplete'
          GROUP BY us.symbol
       ) cov
      WHERE u.symbol = cov.symbol
        AND u.backfilled = true
        AND (
          cov.bars = 0
          OR cov.oldest > $1::timestamptz + ($2::int * interval '1 day')
          OR cov.newest < $3::timestamptz
        )
      RETURNING u.symbol`,
    [requestedStart, GAP_THRESHOLD_DAYS, staleCutoff],
  );

  if (rows.length > 0) {
    log('info', 're-armed symbols with incomplete coverage', {
      requestedStart: requestedStart.slice(0, 10),
      thresholdDays: GAP_THRESHOLD_DAYS,
      staleTailDays: STALE_TAIL_DAYS,
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
