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
// without racing against real Redis I/O scheduling.
function makeMockBucket(capacity = 60) {
  const ratePerMs = capacity / 60_000;
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
          const cap = parseFloat(capStr);
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
  // Real Redis integration: proves the Lua script is wired up correctly.
  it('drains full bucket (60 req) without sleeping — real Redis', async () => {
    vi.useFakeTimers();
    // With fake timers active, any sleep would require vi.advanceTimersByTimeAsync.
    // If acquire sleeps, this loop never completes → test timeout = proof of no sleep.
    for (let i = 0; i < 60; i++) {
      await acquire(redis);
    }
  });

  // Real Redis integration: proves the sleep-and-retry round-trip with real I/O.
  it('sleeps on exhaustion and resolves after refill — real time ~100ms', async () => {
    // Pre-set 0.9 tokens so wait_ms = ceil((1-0.9)/rate) ≈ 100ms real sleep.
    await redis.hmset(
      BUCKET_KEY,
      'tokens',
      '0.9',
      'last_refill',
      String(Date.now()),
    );
    await acquire(redis);
  }, 5_000);

  // Real Redis integration: proves Lua refill arithmetic on elapsed time.
  it('Lua refill arithmetic: backdating last_refill by 5s refills 5 tokens', async () => {
    vi.useFakeTimers();
    // Drain all 60 tokens.
    for (let i = 0; i < 60; i++) {
      await acquire(redis);
    }
    // Backdate last_refill by 5000ms so the next eval sees 5s elapsed → 5 new tokens.
    const past = Date.now() - 5_000;
    await redis.hset(BUCKET_KEY, 'last_refill', String(past));

    // 5 acquires must succeed without sleeping (fake timers: no advance needed).
    for (let i = 0; i < 5; i++) {
      await acquire(redis);
    }
  });

  // Timing tests use a mock bucket so fake timers work without real I/O races.
  it('bucket drains and refills across a window boundary', async () => {
    vi.useFakeTimers();
    const bucket = makeMockBucket();

    // Drain
    for (let i = 0; i < 60; i++) {
      await acquire(bucket);
    }

    // Advance 30 s — refills 30 tokens.
    await vi.advanceTimersByTimeAsync(30_000);

    // These 30 calls must succeed without additional sleeping.
    const calls = Array.from({ length: 30 }, () => acquire(bucket));
    await Promise.all(calls);
  });

  it('120 calls complete in just over 60 s (timer-mocked)', async () => {
    vi.useFakeTimers();
    const bucket = makeMockBucket();
    const start = Date.now();

    const calls = Array.from({ length: 120 }, () => acquire(bucket));

    // First 60 drain the bucket; the next 60 each wait ~1 s for a new token.
    await vi.advanceTimersByTimeAsync(61_000);
    await Promise.all(calls);

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(59_000);
    expect(elapsed).toBeLessThan(70_000);
  });
});
