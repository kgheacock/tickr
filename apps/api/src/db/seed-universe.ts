import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from './pool.js';
import { fetchSp500Symbols } from '../universe/wikipedia.js';
import { jobLogger } from '../log/logger.js';

const log = jobLogger('seed:universe');

// Bundled offline fallback — the last-known constituent list, used only when the
// live Wikipedia fetch fails (so a fresh DB can still boot). Inserts only; never
// drives departures (we must not retire live tickers against a stale snapshot).
const csvPath = fileURLToPath(new URL('../../data/sp500.csv', import.meta.url));

// Safety valve mirroring prune-dead: a single reconcile may retire at most this
// fraction of the active universe. A normal quarterly rebalance retires a
// handful; a large fraction means the source diverged from our DB unexpectedly
// — skip departures (keep inserts/reactivations) rather than mass-retire live
// members. The Wikipedia plausibility floor is the first guard; this is the
// second, defending against a valid-but-divergent list.
const MAX_DEPARTURE_FRACTION = parseFloat(
  process.env['UNIVERSE_MAX_DEPARTURE_FRACTION'] ?? '0.1',
);

function loadCsvSymbols(): string[] {
  const text = readFileSync(csvPath, 'utf-8');
  const [, ...lines] = text.split('\n'); // skip header
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const commaIdx = line.indexOf(',');
      return line.slice(0, commaIdx).trim();
    })
    .filter(Boolean);
}

/** INSERT ... ON CONFLICT DO NOTHING for each symbol; returns the insert count. */
async function insertSymbols(
  client: PoolClient,
  symbols: string[],
): Promise<number> {
  let inserted = 0;
  for (const symbol of symbols) {
    const result = await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled)
       VALUES ($1, false)
       ON CONFLICT (symbol) DO NOTHING`,
      [symbol],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/**
 * Reconcile the universe against the live S&P 500 constituent list:
 *   - add new members,
 *   - reactivate returning members (clear removed_at),
 *   - retire departed members (set removed_at) — never delete; the row + its
 *     price history persist so anything referencing the ticker (e.g. a Fantasy
 *     Street roster pick) keeps a record, just in a terminal state.
 *
 * On any fetch/parse failure the live list is unavailable, so we fall back to
 * the bundled CSV for inserts only and skip departures entirely — a failed
 * fetch must never retire live tickers.
 */
export async function seedUniverse(): Promise<void> {
  let liveSymbols: string[] | null = null;
  try {
    liveSymbols = await fetchSp500Symbols();
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'live constituent fetch failed — falling back to bundled CSV (inserts only)',
    );
  }

  const client = await pool.connect();
  try {
    if (!liveSymbols) {
      const inserted = await insertSymbols(client, loadCsvSymbols());
      log.info({ inserted, source: 'csv-fallback' }, 'seeded universe');
      return;
    }

    await client.query('BEGIN');

    const inserted = await insertSymbols(client, liveSymbols);

    // Reactivate any previously-retired members that are back in the index.
    const reactivated = await client.query(
      `UPDATE universe_symbol
          SET removed_at = NULL
        WHERE symbol = ANY($1::text[])
          AND removed_at IS NOT NULL`,
      [liveSymbols],
    );

    // Departed = currently active but no longer in the live list.
    const { rows: departedRows } = await client.query<{ symbol: string }>(
      `SELECT symbol
         FROM universe_symbol
        WHERE removed_at IS NULL
          AND NOT (symbol = ANY($1::text[]))
        ORDER BY symbol`,
      [liveSymbols],
    );
    const departed = departedRows.map((r) => r.symbol);

    const { rows: activeRows } = await client.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM universe_symbol
        WHERE removed_at IS NULL`,
    );
    const activeTotal = activeRows[0]?.total ?? 0;

    let retired = 0;
    if (departed.length === 0) {
      // nothing to retire
    } else if (departed.length > activeTotal * MAX_DEPARTURE_FRACTION) {
      log.warn(
        {
          departed: departed.length,
          activeTotal,
          maxFraction: MAX_DEPARTURE_FRACTION,
          symbols: departed,
        },
        'too many departures — skipping retirement (source diverged unexpectedly)',
      );
    } else {
      const result = await client.query(
        `UPDATE universe_symbol
            SET removed_at = now()
          WHERE symbol = ANY($1::text[])
            AND removed_at IS NULL`,
        [departed],
      );
      retired = result.rowCount ?? 0;
    }

    await client.query('COMMIT');
    log.info(
      {
        live: liveSymbols.length,
        inserted,
        reactivated: reactivated.rowCount ?? 0,
        retired,
        source: 'wikipedia',
      },
      'reconciled universe',
    );
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const thisFile = fileURLToPath(import.meta.url);
const mainFile = process.argv[1] ? resolve(process.argv[1]) : '';

if (mainFile === thisFile) {
  await seedUniverse()
    .then(() => pool.end())
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
