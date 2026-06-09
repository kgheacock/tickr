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
import { massiveGet, MassiveRateLimitError } from '../../src/massive/client.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const REAL_API_KEY = process.env['MASSIVE_API_KEY'];
let redis: Redis;

beforeAll(() => {
  process.env['ROLE'] = 'worker';
  process.env['MASSIVE_API_KEY'] ??= 'test-key';
  redis = new Redis(REDIS_URL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await redis.quit();
});

vi.mock('../../src/massive/bucket.js', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  BUCKET_KEY: 'massive:bucket',
}));

// Capture every argument the client passes to its logger, so we can assert the
// API key / Authorization header is never among them. Mocking the logger is
// robust (no stdout/fd capture races); pino's real destination binds at import
// and writes via SonicBoom in the vitest worker, so a stdout spy sees nothing.
const { logCalls } = vi.hoisted(() => ({
  logCalls: [] as Array<{ obj: unknown; msg: unknown }>,
}));
vi.mock('../../src/log/logger.js', () => {
  const rec = (obj: unknown, msg?: unknown): void => {
    logCalls.push({ obj, msg });
  };
  const fake = { debug: rec, info: rec, warn: rec, error: rec };
  return {
    jobLogger: () => fake,
    rootLogger: fake,
    baseLoggerOptions: {},
    genRequestId: () => 'test',
  };
});

describe('massiveGet', () => {
  it('calls acquire exactly once per request', async () => {
    const { acquire } = await import('../../src/massive/bucket.js');
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'OK',
          results: [],
          resultsCount: 0,
          ticker: 'AAPL',
          queryCount: 0,
        }),
        { status: 200 },
      ),
    );

    await massiveGet(
      redis,
      '/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-12-31',
      {},
      mockFetch,
    );

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces 429 as MassiveRateLimitError without retrying', async () => {
    const { acquire } = await import('../../src/massive/bucket.js');
    vi.mocked(acquire).mockClear();

    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('rate limited', { status: 429 }));

    await expect(
      massiveGet(
        redis,
        '/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-12-31',
        {},
        mockFetch,
      ),
    ).rejects.toBeInstanceOf(MassiveRateLimitError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on ECONNRESET and eventually throws', async () => {
    const connReset = Object.assign(new Error('socket hang up'), {
      cause: { code: 'ECONNRESET' },
    });
    const mockFetch = vi.fn().mockRejectedValue(connReset);

    await expect(
      massiveGet(
        redis,
        '/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-12-31',
        {},
        mockFetch,
      ),
    ).rejects.toThrow('socket hang up');

    // 1 initial + 3 retries = 4 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('retries when its own request timeout aborts, then throws', async () => {
    vi.useFakeTimers();
    try {
      // Never resolves on its own; rejects with an AbortError when the client's
      // internal TIMEOUT_MS timer fires and aborts the request.
      const mockFetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            (init.signal as AbortSignal).addEventListener('abort', () => {
              reject(
                new DOMException('This operation was aborted', 'AbortError'),
              );
            });
          }),
      );

      const promise = massiveGet(
        redis,
        '/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-12-31',
        {},
        mockFetch,
      ).catch((err: unknown) => err);

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeInstanceOf(DOMException);
      expect((result as DOMException).name).toBe('AbortError');
      // 1 initial + 3 retries = 4 total attempts (timeout is retryable)
      expect(mockFetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry on non-network errors', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('server error', { status: 500 }));

    await expect(
      massiveGet(
        redis,
        '/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-12-31',
        {},
        mockFetch,
      ),
    ).rejects.toThrow('Massive HTTP 500');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends Authorization: Bearer header (not query param)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'OK',
          results: [],
          resultsCount: 0,
          ticker: 'AAPL',
          queryCount: 0,
        }),
        { status: 200 },
      ),
    );

    await massiveGet(
      redis,
      '/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-12-31',
      {},
      mockFetch,
    );

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(url).not.toContain('test-key');
  });

  it('never passes the API key or Authorization header to the logger', async () => {
    const apiKey = process.env['MASSIVE_API_KEY']!;
    logCalls.length = 0;

    // A 500 is non-retryable → throws immediately after logging the error
    // lines ({path,status} then {path,attempt,err}). Forces real log output.
    const mockFetch = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 500 }));

    await expect(
      massiveGet(
        redis,
        '/v2/aggs/ticker/AAPL/range/1/day/2024-01-01/2024-12-31',
        {},
        mockFetch,
      ),
    ).rejects.toThrow();

    // Guard against a vacuous pass: prove logging actually happened.
    expect(logCalls.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(logCalls);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('Bearer');
  });
});

describe('role guard', () => {
  it('throws at import time when ROLE is not worker', async () => {
    vi.resetModules();
    const saved = process.env['ROLE'];
    process.env['ROLE'] = 'api';
    try {
      await expect(import('../../src/massive/index.js')).rejects.toThrow(
        /imported outside the worker role/,
      );
    } finally {
      process.env['ROLE'] = saved;
      vi.resetModules();
    }
  });
});

describe.skipIf(!REAL_API_KEY)('live integration', () => {
  it('GET /v2/aggs for AAPL returns daily bars', async ({ skip }) => {
    process.env['MASSIVE_API_KEY'] = REAL_API_KEY!;
    const liveRedis = new Redis(REDIS_URL);
    try {
      const to = new Date().toISOString().slice(0, 10);
      const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      type Resp = { status: string; results: Array<{ t: number; c: number }> };
      const result = await massiveGet<Resp>(
        liveRedis,
        `/v2/aggs/ticker/AAPL/range/1/day/${from}/${to}`,
        { sort: 'asc' },
      );
      expect(result.status).toBe('OK');
      expect(result.results.length).toBeGreaterThan(0);
      expect(typeof result.results[0]!.c).toBe('number');
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('401') || err.message.includes('403'))
      ) {
        skip();
      }
      throw err;
    } finally {
      process.env['MASSIVE_API_KEY'] = 'test-key';
      await liveRedis.quit();
    }
  }, 15_000);
});
