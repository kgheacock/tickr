import { runner } from 'node-pg-migrate';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

export async function runMigrations(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is not set');
  }

  // api and worker both call runMigrations() on startup and may race for the
  // advisory lock node-pg-migrate uses. Retry with backoff so whichever loses
  // the race waits for the winner to finish, then finds nothing left to do.
  const MAX_ATTEMPTS = 6;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await runner({
        databaseUrl,
        dir: migrationsDir,
        direction: 'up',
        migrationsTable: 'pgmigrations',
        verbose: true,
      });
      return;
    } catch (err) {
      const isLockConflict =
        err instanceof Error &&
        err.message.includes('Another migration is already running');
      if (isLockConflict && attempt < MAX_ATTEMPTS - 1) {
        const delay = 2000 * (attempt + 1);
        console.log(
          `[migrate] lock held by another process, retrying in ${delay}ms…`,
        );
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      throw err;
    }
  }
}

// Run directly when invoked as the entry module (pnpm run db:migrate).
const thisFile = fileURLToPath(import.meta.url);
const mainFile = process.argv[1] ? resolve(process.argv[1]) : '';

if (mainFile === thisFile) {
  await runMigrations().catch((err: unknown) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
