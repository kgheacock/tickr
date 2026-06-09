import { runMigrations } from '../db/migrate.js';
import { seedSystemUser } from '../bootstrap/system-user.js';
import { bootstrapAdmins } from '../bootstrap/admin.js';
import { seedSp500 } from '../bootstrap/seed-sp500.js';
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
  // Refresh the seeded sp500 ETF over the currently-backfilled corpus. Safe to
  // run every startup; skips when nothing is backfilled yet (item 18).
  await seedSp500();

  const redis = getRedis();
  registerScheduledJobs(redis);

  await new Promise<never>(() => {
    /* never resolves — cron keeps the process alive */
  });
}
