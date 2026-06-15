import { runMigrations } from '../db/migrate.js';
import { seedSystemUser } from '../bootstrap/system-user.js';
import { bootstrapAdmins } from '../bootstrap/admin.js';
import { seedSp500 } from '../bootstrap/seed-sp500.js';
import { getRedis } from '../redis.js';
import { registerScheduledJobs } from '../jobs/scheduler.js';
import { requireEnv } from '../config.js';

export async function runWorker(): Promise<void> {
  // MASSIVE_API_KEY is mandatory in prod (every data job needs it). The dev-only
  // TICKR_DISABLE_REMOTE_JOBS=1 skips all external-data jobs (see scheduler.ts),
  // so the key isn't needed then — deploy.sh refuses that flag in prod, keeping
  // the loud-fail-without-key invariant intact for real deploys.
  if (process.env['TICKR_DISABLE_REMOTE_JOBS'] !== '1') {
    try {
      requireEnv('MASSIVE_API_KEY');
    } catch {
      console.error(
        JSON.stringify({
          level: 'error',
          component: 'worker',
          msg: 'MASSIVE_API_KEY is required but not set — backfill cannot run',
        }),
      );
      process.exit(1);
    }
  }

  // FINNHUB_API_KEY powers only the daily early close capture (item 30), not the
  // core Massive pipeline — so a missing key is a warning, not a fatal. Surface it
  // at boot, though: without it the capture would otherwise fail every symbol on
  // each trading day's run, silently, visible only deep in the logs.
  if (!process.env['FINNHUB_API_KEY']) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        component: 'worker',
        msg: 'FINNHUB_API_KEY not set — daily early close-capture (item 30) will no-op until it is provided',
      }),
    );
  }

  await runMigrations();
  await seedSystemUser();
  await bootstrapAdmins();
  // Refresh the seeded sp500 ETF over the currently-backfilled corpus. Safe to
  // run every startup; skips when nothing is backfilled yet (item 18).
  await seedSp500();

  const redis = getRedis();
  registerScheduledJobs(redis);

  await new Promise<never>(() => {
    /* never resolves — cron keeps the process alive */
  });
}
