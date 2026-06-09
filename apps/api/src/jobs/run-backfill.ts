import { runMigrations } from '../db/migrate.js';
import { seedUniverse } from '../db/seed-universe.js';
import { closePool } from '../db/pool.js';
import { getRedis } from '../redis.js';
import { runBackfill } from './backfill.js';
import { resetSymbolsMissingHistory } from './widen-history.js';
import { pruneDeadSymbols } from './prune-dead.js';

// One-shot, idempotent bootstrap of price data:
//   1. migrations  — node-pg-migrate, applies only what's pending
//   2. seed universe — INSERT ... ON CONFLICT DO NOTHING from data/sp500.csv
//   3. widen history — re-arm symbols whose stored coverage falls short of the
//                    requested window (missing early history, stale tail, or no
//                    bars at all); skips terminal data_status = 'incomplete'
//   4. backfill    — fetches history for symbols with backfilled = false;
//                    insertBars uses ON CONFLICT (symbol, ts) DO NOTHING; zero-
//                    bar symbols are left backfilled = false (not masked)
//   5. prune dead  — hard-remove the zero-bar leftovers (wrong/delisted tickers)
//                    so no stale symbol remains in the universe
//
// Steps 3 and 5 are script-only — the worker deliberately does not re-derive
// coverage or delete rows. Unlike the worker role (which runs backfill then
// blocks forever for cron), this exits when the backfill finishes — suitable
// for `pnpm backfill`.
async function main(): Promise<void> {
  await runMigrations();
  await seedUniverse();
  await resetSymbolsMissingHistory();

  const redis = getRedis();
  try {
    const { failed } = await runBackfill(redis);
    // Exclude symbols that threw this run (transient) — they are retry
    // candidates, not dead. Everything else with zero bars is removed.
    await pruneDeadSymbols(failed);
  } finally {
    await redis.quit();
    await closePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('backfill bootstrap failed:', err);
    process.exit(1);
  });
