import type { Redis } from 'ioredis';
import { acquire } from './bucket.js';
import { requireEnv } from '../config.js';
import { jobLogger } from '../log/logger.js';

const baseLog = jobLogger('finnhub');

export class FinnhubRateLimitError extends Error {
  readonly status = 429;
  constructor() {
    super('Finnhub responded with 429 — rate limited after retries');
    this.name = 'FinnhubRateLimitError';
  }
}

const BASE = 'https://finnhub.io/api/v1';
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
// Network-transient backoff (timeout / reset), indexed by attempt number.
const RETRY_DELAYS_MS = [250, 1_000, 2_000] as const;
// 429 backoff used only when Finnhub sends no Retry-After header. Longer than the
// network schedule: a 429 means we're over the per-minute window, so a sub-second
// retry would just clip it again. Honors Retry-After first when present.
const RATE_LIMIT_DELAYS_MS = [1_000, 2_000, 5_000] as const;

function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const cause = (err as { cause?: unknown }).cause;
  if (cause != null && typeof cause === 'object' && 'code' in cause) {
    const code = (cause as { code?: string }).code;
    return code === 'ETIMEDOUT' || code === 'ECONNRESET';
  }
  return false;
}

/**
 * Parse a Retry-After header into a millisecond delay. Finnhub sends seconds, but
 * the spec also allows an HTTP date — handle both, ignore anything unparseable.
 */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1_000);
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchFn(url, { signal: ctrl.signal });
      clearTimeout(timer);

      if (res.status === 429) {
        // A 429 is transient — we're over the per-minute window, not broken. Wait
        // (honoring Retry-After) and retry. Only after exhausting retries do we
        // surface FinnhubRateLimitError, which the close-capture sweep catches to
        // skip just this symbol (its scorer falls back to authoritative bars).
        if (attempt >= MAX_RETRIES) {
          log('error', 'finnhub 429 — retries exhausted', { path, attempt });
          throw new FinnhubRateLimitError();
        }
        const delay =
          retryAfterMs(res) ?? RATE_LIMIT_DELAYS_MS[attempt] ?? 5_000;
        log('warn', 'finnhub 429 — backing off', { path, attempt, delay });
        await sleep(delay);
        continue;
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
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 2_000;
        log('warn', 'finnhub retryable error — backing off', {
          path,
          attempt,
          delay,
          code: (err as { cause?: { code?: string } }).cause?.code,
        });
        await sleep(delay);
        continue;
      }
      log('error', 'finnhub request failed', {
        path,
        attempt,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // unreachable — loop always throws or returns
  throw new Error('finnhubGet: unexpected exit');
}
