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

  await runner({
    databaseUrl,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: true,
  });
}

// Run directly when invoked as the entry module (npm run db:migrate).
const thisFile = fileURLToPath(import.meta.url);
const mainFile = process.argv[1] ? resolve(process.argv[1]) : '';

if (mainFile === thisFile) {
  await runMigrations().catch((err: unknown) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
