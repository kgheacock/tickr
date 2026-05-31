import { runMigrations } from '../db/migrate.js';
import { seedSystemUser } from '../bootstrap/system-user.js';
import { bootstrapAdmins } from '../bootstrap/admin.js';

export async function runWorker(): Promise<void> {
  await runMigrations();
  await seedSystemUser();
  await bootstrapAdmins();

  console.log('[worker] started — no scheduled jobs registered yet');
  await new Promise<never>(() => {
    /* never resolves */
  });
}
