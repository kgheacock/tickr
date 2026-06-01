#!/usr/bin/env tsx
/**
 * One-time bootstrap: streams the Kaggle US stock history dataset into
 * price_bar for all known universe_symbol rows, then marks them backfilled.
 *
 * Run BEFORE the Massive backfill job so that job only needs to fill the gap
 * from KAGGLE_CUTOFF_DATE (2024-07-06) to today:
 *   BACKFILL_START_DATE=2024-07-06 npm run backfill
 *
 * Usage (from repo root):
 *   npm run kaggle:backfill
 *   npx tsx scripts/kaggle-backfill.ts
 *
 * Reads DATABASE_URL, KAGGLE_USERNAME, and KAGGLE_API_KEY from the environment.
 * If DATABASE_URL is not set, the script attempts to load .env from the repo root.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(20, Number);

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

// Required by modules that check ROLE at import time.
process.env['ROLE'] = 'worker';

async function main() {
  const { requireEnv } = await import('../apps/api/src/config.js');

  requireEnv('KAGGLE_USERNAME');
  requireEnv('KAGGLE_API_KEY');
  requireEnv('DATABASE_URL');

  const { downloadDataset } = await import('../apps/api/src/kaggle/client.js');
  const { parseHistory } =
    await import('../apps/api/src/kaggle/parseHistory.js');
  const { insertBars } = await import('../apps/api/src/jobs/insertBars.js');

  const pool = new pg.Pool({
    connectionString: process.env['DATABASE_URL'],
    max: 3,
  });

  const { rows: symbolRows } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol`,
  );
  const knownSymbols = new Set(symbolRows.map((r) => r.symbol));
  console.log(
    `[kaggle-backfill] loaded ${knownSymbols.size} known symbols from universe_symbol`,
  );

  let symbolsImported = 0;
  let skippedSymbols = 0;

  console.log('[kaggle-backfill] downloading dataset...');
  const stream = await downloadDataset(
    'ericstanley/us-stock-market-history-data-csv',
  );

  const { imported, skipped } = await parseHistory(
    stream,
    async (symbol, rows) => {
      await insertBars(
        symbol,
        rows.map((r) => ({
          t: new Date(r.date).getTime(),
          o: r.open,
          h: r.high,
          l: r.low,
          c: r.close,
          v: r.volume,
        })),
      );
      await pool.query(
        `UPDATE universe_symbol SET backfilled = true, backfilled_at = now() WHERE symbol = $1`,
        [symbol],
      );
      symbolsImported++;
      console.log(`[kaggle-backfill] ${symbol}: ${rows.length} bars`);
    },
    knownSymbols,
  );

  skippedSymbols = knownSymbols.size - symbolsImported;

  console.log(
    `[kaggle-backfill] done: ${symbolsImported} symbols imported, ` +
      `${skippedSymbols} symbols not in dataset, ` +
      `${imported} rows inserted, ${skipped} rows skipped (unknown symbol)`,
  );

  await pool.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
