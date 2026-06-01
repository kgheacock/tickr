import { runMigrations } from '../db/migrate.js';
import { seedSystemUser } from '../bootstrap/system-user.js';
import { getRedis } from '../redis.js';
import { seedIndexBot } from '../bot/seed-index.js';

export async function runBot(): Promise<void> {
  await runMigrations();
  await seedSystemUser();

  const redis = getRedis();
  await seedIndexBot(redis);

  await new Promise<never>(() => {
    /* never resolves — keeps the container alive */
  });
}
