import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { runAlertCheck } from '../../src/alerts/checker.js';
import { recordEodRun, recordMassive429 } from '../../src/metrics/redis.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redis = new Redis(REDIS_URL);

const HOUR_MS = 60 * 60 * 1000;

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

// Quiet deps: no DB, no webhook (alerts fall back to logging).
const quietDeps = {
  backfillRemaining: async () => 0,
  webhookUrl: undefined,
};

describe('alerter — EOD lag', () => {
  it('fires exactly once per stuck-state window', async () => {
    const t0 = Date.now();
    await recordEodRun(redis, 1000, 5); // last run stamped at ~t0

    const stale = t0 + 27 * HOUR_MS; // 27h later → lag > 26h

    // First check while stale: fires.
    expect(
      await runAlertCheck(redis, { ...quietDeps, now: () => stale }),
    ).toContain('eod-lag');
    // Still stale on the next window: does NOT fire again.
    expect(
      await runAlertCheck(redis, { ...quietDeps, now: () => stale }),
    ).not.toContain('eod-lag');

    // Condition resolves (fresh run) → flag clears.
    await recordEodRun(redis, 1000, 5);
    const fresh = Date.now();
    expect(
      await runAlertCheck(redis, { ...quietDeps, now: () => fresh }),
    ).not.toContain('eod-lag');

    // Goes stale again → fires once more.
    expect(
      await runAlertCheck(redis, {
        ...quietDeps,
        now: () => fresh + 27 * HOUR_MS,
      }),
    ).toContain('eod-lag');
  });
});

describe('alerter — Massive 429 burst', () => {
  it('fires once while 429s are recent, clears when they age out', async () => {
    await recordEodRun(redis, 1000, 5); // keep EOD fresh so only 429 fires
    await recordMassive429(redis);

    const now = Date.now();
    const fired = await runAlertCheck(redis, { ...quietDeps, now: () => now });
    expect(fired).toContain('massive-429');

    // Same window: no repeat.
    expect(
      await runAlertCheck(redis, { ...quietDeps, now: () => now }),
    ).not.toContain('massive-429');

    // 6 minutes later the 429 is outside the 5-min window → no alert.
    expect(
      await runAlertCheck(redis, {
        ...quietDeps,
        now: () => now + 6 * 60 * 1000,
      }),
    ).not.toContain('massive-429');
  });
});

describe('alerter — backfill stuck', () => {
  it('fires only after remaining is unchanged for >1h', async () => {
    await recordEodRun(redis, 1000, 5);
    const t0 = Date.now();
    const deps = { webhookUrl: undefined, backfillRemaining: async () => 3 };

    // First observation establishes the baseline timer — no alert yet.
    expect(
      await runAlertCheck(redis, { ...deps, now: () => t0 }),
    ).not.toContain('backfill-stuck');

    // Same value 61 min later → stuck.
    expect(
      await runAlertCheck(redis, { ...deps, now: () => t0 + 61 * 60 * 1000 }),
    ).toContain('backfill-stuck');
  });
});
