import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Redis } from 'ioredis';
import { acquire, BUCKET_KEY } from '../../src/massive/bucket.js';

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

// capacity=1 (burst-capped), ratePerMs = MASSIVE_RPS_LIMIT/60_000.
// Tests use the mock bucket so fake timers drive timing without real I/O races.
const RATE_LIMIT = parseInt(process.env['MASSIVE_RPS_LIMIT'] ?? '5', 10);
const REFILL_MS = Math.ceil(60_000 / RATE_LIMIT); // ms to refill 1 token (12 000ms at 5/min)

function makeMockBucket(rateLimit = RATE_LIMIT) {
  const ratePerMs = rateLimit / 60_000;
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
        ) => {
          const now = parseFloat(nowStr);
          const cap = parseFloat(capStr); // cap = 1 in real bucket
          if (tokens === undefined) {
            tokens = cap;
            lastRefill = now;
          }
          const elapsed = now - lastRefill!;
          tokens = Math.min(cap, tokens + elapsed * ratePerMs);
          lastRefill = now;
          if (tokens >= 1.0) {
            tokens -= 1.0;
            return 0;
          }
          return Math.ceil((1.0 - tokens) / ratePerMs);
        },
      ),
  } as unknown as Redis;
}

describe('bucket', () => {
  // Real Redis integration: proves the Lua script fires one token on a fresh key.
  it('fires the first request immediately (fresh key, capacity=1) — real Redis', async () => {
    vi.useFakeTimers();
    await acquire(redis);
  });

  // Real Redis integration: proves sleep-and-retry round-trip with real I/O.
  it('sleeps on exhaustion and resolves after refill — real time ~1.2s', async () => {
    // Pre-set 0.9 tokens so wait_ms = ceil((1-0.9)/rate) ≈ 1200ms real sleep.
    await redis.hmset(
      BUCKET_KEY,
      'tokens',
      '0.9',
      'last_refill',
      String(Date.now()),
    );
    await acquire(redis);
  }, 10_000);

  // Real Redis integration: proves Lua refill arithmetic on elapsed time.
  it(`Lua refill arithmetic: backdating last_refill by ${REFILL_MS}ms refills 1 token`, async () => {
    vi.useFakeTimers();
    // Drain the 1 token.
    await acquire(redis);
    // Backdate last_refill by one full refill interval → 1 new token.
    const past = Date.now() - REFILL_MS;
    await redis.hset(BUCKET_KEY, 'last_refill', String(past));

    await acquire(redis);
  });

  it('bucket drains and refills across a window boundary', async () => {
    vi.useFakeTimers();
    const bucket = makeMockBucket();

    // First request fires immediately.
    await acquire(bucket);

    // Advance half a refill interval — not enough for a new token.
    await vi.advanceTimersByTimeAsync(REFILL_MS / 2);

    // This call must sleep for the remaining ~half interval.
    const pending = acquire(bucket);
    await vi.advanceTimersByTimeAsync(REFILL_MS);
    await pending;
  });

  it('6 calls complete in just over 60 s (timer-mocked)', async () => {
    vi.useFakeTimers();
    const bucket = makeMockBucket();
    const start = Date.now();

    // 1 immediate + 5 × REFILL_MS ≈ 60 s total.
    const calls = Array.from({ length: 6 }, () => acquire(bucket));
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.all(calls);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(59_000);
    expect(elapsed).toBeLessThan(75_000);
  });
});
