# 05 — Finnhub client

> **Status:** done • **Depends on:** 01 • **PR:** [#8](https://github.com/kgheacock/tickr/pull/8)

## Goal

A single in-process Finnhub REST client, used only by the `worker` role,
with a Redis-backed token bucket honoring Finnhub's 60 req/min free-tier
limit. Caller code awaits a budget slot before each request.

## Pre-reads

- [docs/08-deployment.md §2](../docs/08-deployment.md#2-finnhub-integration)
  — REST-only in v1, rate-limit budget, credentials scope.
- [schema/finhub.io/swagger.json](../schema/finhub.io/) — the Finnhub REST
  surface; only `GET /quote` and `GET /stock/candle` are used in v1.

## Steps

1. **Generate types from Finnhub swagger.** `ppnpm run gen:finnhub` produces
   `apps/api/src/finnhub/finnhub.gen.ts` via `openapi-typescript` against
   the bundled swagger. Commit the generated file.
2. **HTTP client.** `apps/api/src/finnhub/client.ts` exports
   `finnhubGet<T>(path, query)`. Reads `FINNHUB_API_KEY` from env; appends
   `?token=...` (Finnhub's auth shape). Times out at 10 s. Retries on
   `ETIMEDOUT` / `ECONNRESET` (3x, exponential backoff 250ms→2s). Surfaces
   `429` as a typed `FinnhubRateLimitError` without retrying — the bucket
   should have prevented it; a 429 means the bucket is mistuned.
3. **Token bucket in Redis.** `apps/api/src/finnhub/bucket.ts` exports
   `await acquire(): Promise<void>` using a Lua script for atomicity:
   ```
   key = "finnhub:bucket"
   capacity = 60, refill = 60 per 60s
   ```
   On exhaustion, the call sleeps until the next refill tick instead of
   throwing. Configurable via `FINNHUB_RPS_LIMIT` (default 60/min).
4. **Wrap every call.** `finnhubGet` calls `bucket.acquire()` first. No
   path bypasses the bucket. A unit test that mocks the bucket asserts
   exactly one acquire per outbound request.
5. **Concurrency cap.** The worker can issue at most `N` Finnhub requests
   in flight at once (default 4). Use `p-limit`. This bounds memory under
   the bootstrap backfill burst.
6. **Role enforcement.** `apps/api/src/finnhub/index.ts` throws at import
   time if `process.env.ROLE !== 'worker'`. The api and bot containers
   must not call Finnhub directly — they read from `price_bar`.
7. **Tests.** `apps/api/test/finnhub/*.test.ts`:
   - Bucket honors 60/min steady state (timer-mocked).
   - Bucket drains and refills across a window boundary correctly.
   - `429` from upstream bubbles up as `FinnhubRateLimitError`.
   - Importing from a non-worker role throws.

## Files to create

- `apps/api/src/finnhub/client.ts`
- `apps/api/src/finnhub/bucket.ts`
- `apps/api/src/finnhub/index.ts` (re-export + role guard)
- `apps/api/src/finnhub/finnhub.gen.ts` (generated)
- `apps/api/test/finnhub/bucket.test.ts`
- `apps/api/test/finnhub/client.test.ts`

## Definition of done

- [x] `ppnpm run gen:finnhub` regenerates the types deterministically.
- [x] Synthetic load of 120 calls completes in just over 60 s under the
      default bucket (timer-mocked test).
- [x] No code path can call `axios`/`fetch` against `finnhub.io` outside
      `client.ts` (lint rule or grep check in CI).
- [x] The api container fails fast on import if any code accidentally
      imports `finnhub/client.ts`.
- [x] `FINNHUB_API_KEY` never appears in logs (redact at the logger).
