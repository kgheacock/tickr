import { runMigrations } from '../db/migrate.js';
import { seedSystemUser } from '../bootstrap/system-user.js';
import { bootstrapAdmins } from '../bootstrap/admin.js';
import { getRedis } from '../redis.js';
import { registerScheduledJobs } from '../jobs/scheduler.js';

export async function runWorker(): Promise<void> {
  await runMigrations();
  await seedSystemUser();
  await bootstrapAdmins();

  const redis = getRedis();
  registerScheduledJobs(redis);

  await new Promise<never>(() => {
    /* never resolves — cron keeps the process alive */
  });
}
