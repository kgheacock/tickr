import { pool } from '../db/pool.js';

// Fraction of the universe that may be hard-removed in a single bootstrap. A
// healthy run prunes a handful of genuinely dead tickers; a large fraction means
// a systemic fetch failure (Massive outage, bad key) returned no bars for many
// valid symbols — abort rather than delete the universe. Tunable for an
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
 * data at the source across the whole window: a wrong/delisted ticker. Hard-
 * remove it (and any FK children) so it is not a stale NO_BARS row. Symbols that
 * threw a transient error this run are passed in `failedSymbols` and excluded —
 * they are retry candidates, not dead. Partial symbols (some bars) are never
 * pruned here; the backfill marks those data_status = 'incomplete'.
 *
 * Guarded by PRUNE_MAX_FRACTION: if the dead set is implausibly large the prune
 * is skipped and logged, so a transient outage can never empty the universe.
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
      'too many dead symbols — skipping prune (likely a fetch outage)',
      {
        dead: dead.length,
        total,
        maxFraction: PRUNE_MAX_FRACTION,
        symbols: dead,
      },
    );
    return 0;
  }

  // FK children of universe_symbol(symbol) first. After migration 003
  // (platformize) only price_bar and etf_weight still reference it. A dead
  // symbol has zero bars by definition; etf_weight is cleared defensively so the
  // parent delete cannot abort if a basket happened to reference it.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM price_bar  WHERE symbol = ANY($1::text[])`,
      [dead],
    );
    await client.query(
      `DELETE FROM etf_weight WHERE symbol = ANY($1::text[])`,
      [dead],
    );
    await client.query(
      `DELETE FROM universe_symbol WHERE symbol = ANY($1::text[])`,
      [dead],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  log('info', 'pruned dead symbols (no data at source)', {
    pruned: dead.length,
    symbols: dead,
  });
  return dead.length;
}
