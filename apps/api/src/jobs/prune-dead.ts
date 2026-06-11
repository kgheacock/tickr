import { pool } from '../db/pool.js';

// Fraction of the universe that may be retired in a single bootstrap. A healthy
// run retires a handful of genuinely dead tickers; a large fraction means a
// systemic fetch failure (Massive outage, bad key) returned no bars for many
// valid symbols — abort rather than retire the universe. Tunable for an
// intentionally large first cleanup via BACKFILL_PRUNE_MAX_FRACTION.
const PRUNE_MAX_FRACTION = parseFloat(
  process.env['BACKFILL_PRUNE_MAX_FRACTION'] ?? '0.1',
);

function log(level: 'info' | 'warn', msg: string, extra?: object): void {
  console[level](
    JSON.stringify({ level, component: 'prune-dead', msg, ...extra }),
  );
}

/**
 * Script-only (bootstrap) prune of dead symbols — run AFTER runBackfill so every
 * symbol has been attempted with the ticker/limit/masking fixes in place.
 *
 * A symbol that is still backfilled = false with zero price_bar rows produced no
 * data at the source across the whole window: a wrong/delisted ticker. We
 * *retire* it (set removed_at) rather than delete it — a ticker is never dropped
 * from the DB, so anything referencing it keeps a record in a terminal state.
 * Every active-membership query already filters removed_at IS NULL, so a retired
 * symbol falls out of listings, updates, and the seeded ETF. Symbols that threw
 * a transient error this run are passed in `failedSymbols` and excluded — they
 * are retry candidates, not dead. Partial symbols (some bars) are never pruned
 * here; the backfill marks those data_status = 'incomplete'.
 *
 * Guarded by PRUNE_MAX_FRACTION: if the dead set is implausibly large the prune
 * is skipped and logged, so a transient outage can never retire the universe.
 */
export async function pruneDeadSymbols(
  failedSymbols: string[] = [],
): Promise<number> {
  const { rows: deadRows } = await pool.query<{ symbol: string }>(
    `SELECT us.symbol
       FROM universe_symbol us
       LEFT JOIN price_bar pb ON pb.symbol = us.symbol
      WHERE us.backfilled = false
        AND us.removed_at IS NULL
        AND NOT (us.symbol = ANY($1::text[]))
      GROUP BY us.symbol
     HAVING COUNT(pb.ts) = 0
      ORDER BY us.symbol`,
    [failedSymbols],
  );

  const dead = deadRows.map((r) => r.symbol);
  if (dead.length === 0) {
    log('info', 'no dead symbols to prune');
    return 0;
  }

  const { rows: totalRows } = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM universe_symbol WHERE removed_at IS NULL`,
  );
  const total = totalRows[0]?.total ?? 0;

  if (dead.length > total * PRUNE_MAX_FRACTION) {
    log(
      'warn',
      'too many dead symbols — skipping retirement (likely a fetch outage)',
      {
        dead: dead.length,
        total,
        maxFraction: PRUNE_MAX_FRACTION,
        symbols: dead,
      },
    );
    return 0;
  }

  // Soft-retire: a ticker is never dropped from the DB. Setting removed_at keeps
  // the row (and its zero bars) but excludes it from every active-membership
  // query (all of which filter removed_at IS NULL).
  await pool.query(
    `UPDATE universe_symbol
        SET removed_at = now()
      WHERE symbol = ANY($1::text[])
        AND removed_at IS NULL`,
    [dead],
  );

  log('info', 'retired dead symbols (no data at source)', {
    retired: dead.length,
    symbols: dead,
  });
  return dead.length;
}
