import type { Redis } from 'ioredis';
import { acquire } from './bucket.js';
import { requireEnv } from '../config.js';
import { jobLogger } from '../log/logger.js';

const baseLog = jobLogger('finnhub');

export class FinnhubRateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super('Finnhub responded with 429 — token bucket is mistuned');
    this.name = 'FinnhubRateLimitError';
  }
}

const BASE = 'https://finnhub.io/api/v1';
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (cause != null && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: string }).code;
    return code === 'ETIMEDOUT' || code === 'ECONNRESET';
  }
  return false;
}

function log(
  level: 'debug' | 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  baseLog[level](extra ?? {}, msg);
}

export async function finnhubGet<T>(
  redis: Redis,
  path: string,
  query: Record<string, string | number>,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> {
  await acquire(redis);

  const apiKey = requireEnv('FINNHUB_API_KEY');
  const params = new URLSearchParams(
    Object.fromEntries(
      Object.entries({ ...query, token: apiKey }).map(([k, v]) => [
        k,
        String(v),
      ]),
    ),
  );
  // Never log the URL — it carries the API key in the `token` param. Only the
  // path and the (token-free) query are ever logged.
  const url = `${BASE}${path}?${params}`;

  log('debug', 'finnhub request', { path, query });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 2_000;
      log('warn', 'finnhub retry', { path, attempt, delay });
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(url, { signal: ctrl.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        log('error', 'finnhub 429 — bucket mistuned', { path });
        throw new FinnhubRateLimitError();
      }
      if (!res.ok) {
        log('error', 'finnhub non-OK response', { path, status: res.status });
        throw new Error(`Finnhub HTTP ${res.status}`);
      }

      log('debug', 'finnhub response ok', { path, status: res.status });
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof FinnhubRateLimitError) throw err;
      if (isRetryable(err)) {
        log('warn', 'finnhub retryable error', {
          path,
          attempt,
          code: (err as { cause?: { code?: string } }).cause?.code,
        });
      }
      if (!isRetryable(err) || attempt >= MAX_RETRIES) {
        log('error', 'finnhub request failed', {
          path,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }

  // unreachable — loop always throws or returns
  throw new Error('finnhubGet: unexpected exit');
}
