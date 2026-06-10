import type { Redis } from 'ioredis';
import { acquire } from './bucket.js';
import { requireEnv } from '../config.js';
import { jobLogger } from '../log/logger.js';
import { recordMassiveCall, recordMassive429 } from '../metrics/redis.js';

const baseLog = jobLogger('massive');

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
  baseLog[level](extra ?? {}, msg);
}

function buildUrl(
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  const params = query
    ? '?' +
      new URLSearchParams(
        Object.fromEntries(
          Object.entries(query).map(([k, v]) => [k, String(v)]),
        ),
      ).toString()
    : '';
  return `${BASE}${path}${params}`;
}

// One request to an absolute Massive URL, with the token bucket, timeout and
// transient-error retry, returning the raw OK `Response`. Used both for the
// first page (built from path+query) and for following a next_url (already an
// absolute URL). One bucket token is acquired per call, so each page of a
// paginated fetch — and every image download — is rate-limited. Callers decode
// the body (`.json()` / `.arrayBuffer()`) once it returns.
async function requestRaw(
  redis: Redis,
  url: string,
  fetchFn: typeof globalThis.fetch,
): Promise<Response> {
  await acquire(redis);

  // Key is in the Authorization header — the URL is safe to log.
  const apiKey = requireEnv('MASSIVE_API_KEY');
  log('debug', 'massive request', { url });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 2_000;
      log('warn', 'massive retry', { url, attempt, delay });
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

      // Fire-and-forget metric writes — never block or fail a request on them.
      void recordMassiveCall(redis).catch(() => {});

      if (res.status === 429) {
        void recordMassive429(redis).catch(() => {});
        log('error', 'massive 429 — bucket mistuned', { url });
        throw new MassiveRateLimitError();
      }
      if (!res.ok) {
        log('error', 'massive non-OK response', { url, status: res.status });
        throw new Error(`Massive HTTP ${res.status}`);
      }

      log('debug', 'massive response ok', { url, status: res.status });
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof MassiveRateLimitError) throw err;
      // Our own TIMEOUT_MS abort surfaces as an AbortError with no errno cause;
      // treat it as a transient, retryable failure (slow response, not fatal).
      const retryable = timedOut || isRetryable(err);
      if (retryable) {
        log('warn', 'massive retryable error', {
          url,
          attempt,
          code: timedOut
            ? 'TIMEOUT'
            : (err as { cause?: { code?: string } }).cause?.code,
        });
      }
      if (!retryable || attempt >= MAX_RETRIES) {
        log('error', 'massive request failed', {
          url,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }
  }

  throw new Error('requestRaw: unexpected exit');
}

export async function massiveGet<T>(
  redis: Redis,
  path: string,
  query?: Record<string, string | number | boolean>,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<T> {
  const res = await requestRaw(redis, buildUrl(path, query), fetchFn);
  return (await res.json()) as T;
}

export interface MassiveBytes {
  bytes: Buffer;
  contentType: string;
}

/**
 * Download a binary asset (a branding logo/icon) from an absolute Massive URL
 * on the same bucket + retry path as the JSON calls — so no code path fetches
 * `api.massive.com` outside this module, and image downloads count against the
 * same rate-limit budget as everything else.
 */
export async function massiveGetBytes(
  redis: Redis,
  url: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<MassiveBytes> {
  const res = await requestRaw(redis, url, fetchFn);
  const bytes = Buffer.from(await res.arrayBuffer());
  const contentType =
    res.headers.get('content-type') ?? 'application/octet-stream';
  return { bytes, contentType };
}

interface AggPage<TBar> {
  results?: TBar[];
  next_url?: string;
}

// Safety valve against a pathological next_url cycle. Two years of 15-min bars
// is ~8 pages at the free tier's ~4k-bar page; 2000 is far above any real run.
const MAX_PAGES = 2_000;

/**
 * Fetch every page of a paginated aggregates request, invoking `onPage` with
 * each page's results as they arrive (so callers can insert incrementally
 * instead of buffering the whole symbol in memory).
 *
 * The free Massive tier caps each response at ~4k bars and returns a `next_url`
 * for the remainder; a single request can therefore not be trusted to return a
 * full range. We follow next_url (an absolute URL carrying the cursor) until it
 * is absent. Each page is a separate rate-limited request via requestRaw.
 */
export async function massiveGetPaged<TBar>(
  redis: Redis,
  path: string,
  query: Record<string, string | number | boolean> | undefined,
  onPage: (results: TBar[]) => Promise<void>,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  let url: string | undefined = buildUrl(path, query);
  let pages = 0;
  while (url) {
    const res = await requestRaw(redis, url, fetchFn);
    const page = (await res.json()) as AggPage<TBar>;
    const results = page.results ?? [];
    if (results.length > 0) await onPage(results);
    pages += 1;
    url = page.next_url && pages < MAX_PAGES ? page.next_url : undefined;
  }
}
