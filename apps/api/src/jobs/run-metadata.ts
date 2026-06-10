import { runMigrations } from '../db/migrate.js';
import { seedUniverse } from '../db/seed-universe.js';
import { closePool } from '../db/pool.js';
import { getRedis } from '../redis.js';
import { runMetadataRefresh } from './refresh-metadata.js';

// One-shot, idempotent refresh of ticker metadata + branding (logos/icons):
//   1. migrations    — node-pg-migrate, applies only what's pending
//   2. seed universe — INSERT ... ON CONFLICT DO NOTHING from data/sp500.csv,
//                      so a fresh DB has symbols to fetch metadata for
//   3. refresh       — fetch reference details and download logo/icon images for
//                      symbols whose metadata/branding is missing or aged out
//                      (METADATA_TTL_DAYS); each artifact upserts as it lands, so
//                      an interrupt resumes from where it stopped on the next run
//
// Shares the Massive token bucket with the backfill, so a full first run over
// ~500 symbols is slow (the bucket, not this loop, is the limiter). Routine
// re-runs only touch stale rows. Exits when the refresh finishes — suitable for
// `pnpm metadata`.
async function main(): Promise<void> {
  await runMigrations();
  await seedUniverse();

  const redis = getRedis();
  try {
    const result = await runMetadataRefresh(redis);
    console.log(
      `[metadata] done: metadata=${result.metadata} logos=${result.logos} ` +
        `icons=${result.icons} failed=${result.failed.length}/${result.total}`,
    );
  } finally {
    await redis.quit();
    await closePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('metadata refresh failed:', err);
    process.exit(1);
  });
