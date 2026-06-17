import { runMigrations } from '../db/migrate.js';
import { pool, closePool } from '../db/pool.js';
import { runClassifier } from '../fantasy/classify.js';

// One-shot, idempotent run of the Fantasy Street player (stock) classifier:
//   1. migrations  — node-pg-migrate, applies only what's pending (ensures
//                    fs_player_classification exists on a fresh DB)
//   2. classify    — recompute trailing returns / volatility from price_bar for
//                    every backfilled symbol and replace fs_player_classification
//                    in one transaction; a re-run over unchanged data writes the
//                    same rows
//
// Operates purely on price data already in the DB — it fetches nothing external,
// so run it after `pnpm backfill`. Mirrors the worker's weekly classifier cron;
// exits when the recompute finishes — suitable for `pnpm classify`.
async function main(): Promise<void> {
  await runMigrations();

  try {
    const n = await runClassifier(pool);
    console.log(`[classify] done: ${n} symbols classified`);
  } finally {
    await closePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('classifier run failed:', err);
    process.exit(1);
  });
