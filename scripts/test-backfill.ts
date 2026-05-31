#!/usr/bin/env tsx
/**
 * End-to-end backfill smoke test. Seeds a small set of symbols, runs the
 * backfill with a configurable short lookback, and prints a row count summary.
 *
 * Usage (from repo root):
 *   BACKFILL_LOOKBACK_DAYS=3 BACKFILL_WINDOW_DAYS=3 tsx scripts/test-backfill.ts AAPL PYPL
 *
 * Reads DATABASE_URL, REDIS_URL, and FINNHUB_API_KEY from the environment.
 * If DATABASE_URL is not set, the script attempts to load .env from the repo root.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { Redis } from 'ioredis';

pg.types.setTypeParser(20, Number);

// Load .env from the repo root (cwd) before anything else touches env vars.
// Must happen at module level — before main() — so the dynamic import of
// backfill.ts (which reads BACKFILL_* as module-level constants) sees them.
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

process.env['ROLE'] = 'worker';
process.env['BACKFILL_LOOKBACK_DAYS'] ??= '3';
process.env['BACKFILL_WINDOW_DAYS'] ??= '3';

async function main() {
  const SYMBOLS = process.argv.slice(2).map((s) => s.toUpperCase());
  if (SYMBOLS.length === 0) SYMBOLS.push('AAPL', 'PYPL');

  const dbUrl = process.env['DATABASE_URL']!;
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

  // Dynamic import AFTER the module-level env var assignments have run,
  // so backfill.ts evaluates BACKFILL_LOOKBACK_DAYS / BACKFILL_WINDOW_DAYS correctly.
  const { runBackfill } = await import('../apps/api/src/jobs/backfill.js');

  const pool = new pg.Pool({ connectionString: dbUrl, max: 3 });
  const redis = new Redis(redisUrl);

  console.log(
    `\n[test-backfill] symbols=${SYMBOLS.join(',')}  lookback=${process.env['BACKFILL_LOOKBACK_DAYS']}d  window=${process.env['BACKFILL_WINDOW_DAYS']}d\n`,
  );

  // Reset backfilled flag so the job picks these symbols up.
  for (const symbol of SYMBOLS) {
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled)
       VALUES ($1, false)
       ON CONFLICT (symbol) DO UPDATE SET backfilled = false, backfilled_at = NULL`,
      [symbol],
    );
    console.log(`[test-backfill] seeded ${symbol} (backfilled=false)`);
  }

  console.log('\n[test-backfill] running backfill...\n');
  try {
    await runBackfill(redis);
  } catch (err) {
    console.error('\n[test-backfill] backfill error:', err);
    await pool.end();
    await redis.quit();
    process.exit(1);
  }

  // Report results.
  console.log('\n[test-backfill] results:\n');
  for (const symbol of SYMBOLS) {
    const { rows: meta } = await pool.query<{
      backfilled: boolean;
      backfilled_at: string | null;
    }>(
      `SELECT backfilled, backfilled_at FROM universe_symbol WHERE symbol = $1`,
      [symbol],
    );
    const { rows: counts } = await pool.query<{
      count: string;
      min_ts: string;
      max_ts: string;
    }>(
      `SELECT count(*), min(ts)::text AS min_ts, max(ts)::text AS max_ts
       FROM price_bar WHERE symbol = $1`,
      [symbol],
    );
    const m = meta[0];
    const c = counts[0];
    console.log(
      `  ${symbol.padEnd(6)}  backfilled=${String(m?.backfilled ?? '?').padEnd(5)}  ` +
        `bars=${String(c?.count ?? 0).padStart(5)}  ` +
        `from=${(c?.min_ts ?? '-').slice(0, 16)}  to=${(c?.max_ts ?? '-').slice(0, 16)}`,
    );
  }

  await pool.end();
  await redis.quit();
  console.log('\n[test-backfill] done.\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
