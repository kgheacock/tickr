import { runMigrations } from '../db/migrate.js';
import { seedSystemUser } from '../bootstrap/system-user.js';
import { bootstrapAdmins } from '../bootstrap/admin.js';
import { getRedis } from '../redis.js';
import { registerScheduledJobs } from '../jobs/scheduler.js';
import { requireEnv } from '../config.js';

export async function runWorker(): Promise<void> {
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

  await runMigrations();
  await seedSystemUser();
  await bootstrapAdmins();

  const redis = getRedis();
  // Pre-warm tip: before the first deploy, run `npm run kaggle:backfill` to
  // bulk-load price history from the Kaggle dataset, then set
  // BACKFILL_START_DATE=2024-07-06 so the backfill job only covers the gap.
  registerScheduledJobs(redis);

  await new Promise<never>(() => {
    /* never resolves — cron keeps the process alive */
  });
}
