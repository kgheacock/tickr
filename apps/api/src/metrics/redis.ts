import type { Redis } from 'ioredis';

/**
 * Cross-process metrics (item 10). Produced in the worker process (Massive
 * client, EOD job) but read by the api process's `GET /admin/ops`, so they
 * must live in shared Redis rather than the in-process registry.
 */

const MASSIVE_429_ZSET = 'metrics:massive:429';
const MASSIVE_CALLS = 'metrics:massive:calls_total';
const EOD_LAST_RUN = 'metrics:eod:last_run_at';
const EOD_DURATION = 'metrics:eod:duration_ms';
const EOD_BARS = 'metrics:eod:bars_written';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Job-lock keys (see jobs/scheduler.ts) — held while a job runs. */
const JOB_LOCK_KEYS = ['massive:job:backfill', 'massive:job:session-update'];

/** Count one Massive HTTP call (lifetime counter). */
export async function recordMassiveCall(redis: Redis): Promise<void> {
  await redis.incr(MASSIVE_CALLS);
}

/**
 * Record a Massive 429. Stored as a timestamped ZSET so the same data answers
 * both the 24h ops window and the 5-minute alert window. Old entries are
 * trimmed on write to keep the set bounded.
 */
export async function recordMassive429(redis: Redis): Promise<void> {
  const now = Date.now();
  const member = `${now}-${Math.random().toString(36).slice(2)}`;
  await redis.zadd(MASSIVE_429_ZSET, now, member);
  await redis.zremrangebyscore(MASSIVE_429_ZSET, 0, now - DAY_MS);
  await redis.pexpire(MASSIVE_429_ZSET, DAY_MS + 60 * 60 * 1000);
}

/**
 * Count Massive 429s within the trailing `windowMs`. `now` is injectable so
 * the alerter (and its tests) can drive the window with a controlled clock.
 */
export async function massive429Count(
  redis: Redis,
  windowMs: number,
  now: number = Date.now(),
): Promise<number> {
  return redis.zcount(MASSIVE_429_ZSET, now - windowMs, now);
}

/** Stamp a successful EOD price-update run. */
export async function recordEodRun(
  redis: Redis,
  durationMs: number,
  barsWritten: number,
): Promise<void> {
  await redis.mset(
    EOD_LAST_RUN,
    new Date().toISOString(),
    EOD_DURATION,
    String(durationMs),
    EOD_BARS,
    String(barsWritten),
  );
}

/** ISO timestamp of the last successful EOD run, or null if none yet. */
export async function getEodLastRun(redis: Redis): Promise<string | null> {
  return redis.get(EOD_LAST_RUN);
}

/** Number of currently-held job locks (a proxy for queue depth). */
export async function jobQueueDepth(redis: Redis): Promise<number> {
  const held = await Promise.all(JOB_LOCK_KEYS.map((k) => redis.exists(k)));
  return held.reduce((sum, n) => sum + n, 0);
}
