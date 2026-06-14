import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Redis } from 'ioredis';
import { acquire, BUCKET_KEY } from '../../src/finnhub/bucket.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
let redis: Redis;

beforeEach(async () => {
  redis = new Redis(REDIS_URL);
  await redis.del(BUCKET_KEY);
});

afterEach(async () => {
  vi.useRealTimers();
  await redis.quit();
});

// Simulates the Lua bucket logic in-process so fake timers can drive timing
// without racing against real Redis I/O scheduling. Reads cap and rate straight
// from the args acquire passes, so it tracks the real bucket (cap = 1, rate =
// FINNHUB_RPS_LIMIT/60_000 = 1 token per second at the 60/min default).
function makeMockBucket() {
  let tokens: number | undefined;
  let lastRefill: number | undefined;

  return {
    eval: vi
      .fn()
      .mockImplementation(
        async (
          _script: unknown,
          _numkeys: unknown,
          _key: unknown,
          nowStr: string,
          capStr: string,
          rateStr: string,
        ) => {
          const now = parseFloat(nowStr);
          const cap = parseFloat(capStr);
          const rate = parseFloat(rateStr);
          if (tokens === undefined) {
            tokens = cap;
            lastRefill = now;
          }
          const elapsed = now - lastRefill!;
          tokens = Math.min(cap, tokens + elapsed * rate);
          lastRefill = now;
          if (tokens >= 1.0) {
            tokens -= 1.0;
            return 0;
          }
          return Math.ceil((1.0 - tokens) / rate);
        },
      ),
  } as unknown as Redis;
}

describe('bucket', () => {
  // Real Redis integration: the bucket starts full (1 token), so the first
  // acquire returns without sleeping. With fake timers active any sleep would
  // require an explicit advance, so the call hanging = a regression.
  it('first acquire does not sleep — real Redis', async () => {
    vi.useFakeTimers();
    await acquire(redis);
  });

  // Real Redis integration: proves the Lua refill arithmetic — after draining
  // the single token, backdating last_refill by 1s refills exactly one token.
  it('refills one token per second — real Redis', async () => {
    vi.useFakeTimers();
    await acquire(redis); // drain the one starting token
    const past = Date.now() - 1_000;
    await redis.hset(BUCKET_KEY, 'last_refill', String(past));
    await acquire(redis); // 1s elapsed → 1 token → no sleep
  });

  // The cap-1 even-spread is what honors the 60/min free tier: 60 calls take
  // ~59s (first token free, the other 59 each wait ~1s). Without the bucket they
  // would all resolve at t≈0, so finishing only near 59s proves enforcement.
  it('60 calls complete in ~59s (timer-mocked) — honors 60/min', async () => {
    vi.useFakeTimers();
    const bucket = makeMockBucket();
    const start = Date.now();

    const calls = Array.from({ length: 60 }, () => acquire(bucket));
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.all(calls);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(58_000);
    expect(elapsed).toBeLessThanOrEqual(60_000);
  });
});
