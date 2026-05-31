import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { Redis } from 'ioredis';
import { finnhubGet, FinnhubRateLimitError } from '../../src/finnhub/client.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
// Capture the real key before beforeAll overwrites it with the test sentinel.
const REAL_API_KEY = process.env['FINNHUB_API_KEY'];
let redis: Redis;

beforeAll(() => {
  process.env['ROLE'] = 'worker';
  // Use a sentinel unless a real key is already present.
  process.env['FINNHUB_API_KEY'] ??= 'test-key';
  redis = new Redis(REDIS_URL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await redis.quit();
});

// Mock the bucket so client tests are not rate-limited by real Redis state.
vi.mock('../../src/finnhub/bucket.js', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  BUCKET_KEY: 'finnhub:bucket',
}));

describe('finnhubGet', () => {
  it('calls acquire exactly once per request', async () => {
    const { acquire } = await import('../../src/finnhub/bucket.js');
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ c: 150 }), { status: 200 }),
      );

    await finnhubGet(redis, '/quote', { symbol: 'AAPL' }, mockFetch);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces 429 as FinnhubRateLimitError without retrying', async () => {
    const { acquire } = await import('../../src/finnhub/bucket.js');
    vi.mocked(acquire).mockClear();

    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429 }));

    await expect(
      finnhubGet(redis, '/quote', { symbol: 'AAPL' }, mockFetch),
    ).rejects.toBeInstanceOf(FinnhubRateLimitError);

    // One acquire, one fetch attempt — no retries on 429
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on ECONNRESET and eventually throws', async () => {
    const connReset = Object.assign(new Error('socket hang up'), {
      cause: { code: 'ECONNRESET' },
    });
    const mockFetch = vi.fn().mockRejectedValue(connReset);

    await expect(
      finnhubGet(redis, '/quote', { symbol: 'AAPL' }, mockFetch),
    ).rejects.toThrow('socket hang up');

    // 1 initial + 3 retries = 4 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('does not retry on non-network errors', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('server error', { status: 500 }));

    await expect(
      finnhubGet(redis, '/quote', { symbol: 'AAPL' }, mockFetch),
    ).rejects.toThrow('Finnhub HTTP 500');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('never logs the API key', async () => {
    const logged: string[] = [];
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }

    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ c: 150 }), { status: 200 }),
      );
    await finnhubGet(redis, '/quote', { symbol: 'AAPL' }, mockFetch);

    for (const entry of logged) {
      expect(entry).not.toContain('test-key');
    }
  });
});

describe('role guard', () => {
  it('throws at import time when ROLE is not worker', async () => {
    vi.resetModules();
    const saved = process.env['ROLE'];
    process.env['ROLE'] = 'api';
    try {
      await expect(import('../../src/finnhub/index.js')).rejects.toThrow(
        /imported outside the worker role/,
      );
    } finally {
      process.env['ROLE'] = saved;
      vi.resetModules();
    }
  });
});

describe.skipIf(!REAL_API_KEY)('live integration', () => {
  it('GET /quote returns a numeric current price for AAPL', async () => {
    // Use the real key for this suite only.
    process.env['FINNHUB_API_KEY'] = REAL_API_KEY!;
    const liveRedis = new Redis(REDIS_URL);
    try {
      type Quote = { c: number; h: number; l: number; o: number; pc: number };
      const result = await finnhubGet<Quote>(liveRedis, '/quote', {
        symbol: 'AAPL',
      });
      expect(typeof result.c).toBe('number');
      expect(result.c).toBeGreaterThan(0);
    } finally {
      process.env['FINNHUB_API_KEY'] = 'test-key';
      await liveRedis.quit();
    }
  }, 15_000);
});
