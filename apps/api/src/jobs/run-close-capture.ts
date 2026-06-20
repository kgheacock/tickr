import { runMigrations } from '../db/migrate.js';
import { closePool } from '../db/pool.js';
import { getRedis } from '../redis.js';
import { runCloseCapture } from './close-capture.js';

// One-shot, idempotent run of the post-close session_close sweep — the same job
// the worker fires on its 21:30-UTC weekday cron, runnable on demand. Its reason
// to exist out-of-band: the cron keys on mostRecentSessionDate, so once the day
// rolls over it can no longer recover a symbol the scheduled sweep dropped (e.g.
// a transient Finnhub 429). Re-run it the SAME session day to backfill those:
// INSERT ... ON CONFLICT (symbol, session_date) DO UPDATE makes a re-sweep
// refresh existing rows and fill the gaps, never duplicating.
//
// Hits the Finnhub API (one /quote per playable symbol, paced by the token
// bucket — a ~502-symbol sweep is ~9 min), so it needs FINNHUB_API_KEY and
// REDIS_URL. Exits when the sweep finishes — suitable for `pnpm close-capture`.
async function main(): Promise<void> {
  await runMigrations();

  const redis = getRedis();
  try {
    await runCloseCapture(redis);
  } finally {
    await redis.quit();
    await closePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('close-capture run failed:', err);
    process.exit(1);
  });
