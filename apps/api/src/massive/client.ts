import type { Redis } from 'ioredis';
import { acquire } from './bucket.js';
import { requireEnv } from '../config.js';

export class MassiveRateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super('Massive responded with 429 — token bucket is mistuned');
    this.name = 'MassiveRateLimitError';
  }
}

const BASE = 'https://api.massive.com';
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
  console[level](
    JSON.stringify({ level, component: 'massive', msg, ...extra }),
  );
}

export async function massiveGet<T>(
  redis: Redis,
  path: string,
  query?: Record<string, string | number | boolean>,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> {
  await acquire(redis);

  // Key is in Authorization header — the URL is safe to log.
  const apiKey = requireEnv('MASSIVE_API_KEY');
  const params = query
    ? '?' +
      new URLSearchParams(
        Object.fromEntries(
          Object.entries(query).map(([k, v]) => [k, String(v)]),
        ),
      ).toString()
    : '';
  const url = `${BASE}${path}${params}`;

  log('debug', 'massive request', { path, query });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 2_000;
      log('warn', 'massive retry', { path, attempt, delay });
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, TIMEOUT_MS);
    try {
      const res = await fetchFn(url, {
        signal: ctrl.signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      clearTimeout(timer);

      if (res.status === 429) {
        log('error', 'massive 429 — bucket mistuned', { path });
        throw new MassiveRateLimitError();
      }
      if (!res.ok) {
        log('error', 'massive non-OK response', { path, status: res.status });
        throw new Error(`Massive HTTP ${res.status}`);
      }

      log('debug', 'massive response ok', { path, status: res.status });
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof MassiveRateLimitError) throw err;
      // Our own TIMEOUT_MS abort surfaces as an AbortError with no errno cause;
      // treat it as a transient, retryable failure (slow response, not fatal).
      const retryable = timedOut || isRetryable(err);
      if (retryable) {
        log('warn', 'massive retryable error', {
          path,
          attempt,
          code: timedOut
            ? 'TIMEOUT'
            : (err as { cause?: { code?: string } }).cause?.code,
        });
      }
      if (!retryable || attempt >= MAX_RETRIES) {
        log('error', 'massive request failed', {
          path,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }

  throw new Error('massiveGet: unexpected exit');
}
