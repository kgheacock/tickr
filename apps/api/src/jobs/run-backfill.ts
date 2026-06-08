import { runMigrations } from '../db/migrate.js';
import { seedUniverse } from '../db/seed-universe.js';
import { closePool } from '../db/pool.js';
import { getRedis } from '../redis.js';
import { runBackfill } from './backfill.js';
import { resetSymbolsMissingHistory } from './widen-history.js';

// One-shot, idempotent bootstrap of price data:
//   1. migrations  — node-pg-migrate, applies only what's pending
//   2. seed universe — INSERT ... ON CONFLICT DO NOTHING from data/sp500.csv
//   3. widen history — re-arm symbols whose stored history no longer reaches the
//                    requested start date (a no-op unless you widened the window)
//   4. backfill    — fetches history only for symbols with backfilled = false,
//                    and insertBars uses ON CONFLICT (symbol, ts) DO NOTHING
//
// Step 3 is script-only — the worker deliberately does not re-derive coverage.
// Unlike the worker role (which runs backfill then blocks forever for cron),
// this exits when the backfill finishes — suitable for `pnpm backfill`.
async function main(): Promise<void> {
  await runMigrations();
  await seedUniverse();
  await resetSymbolsMissingHistory();

  const redis = getRedis();
  try {
    await runBackfill(redis);
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
