# 13 — Massive client

> **Status:** done • **Depends on:** 01 • **PR:** [#9](https://github.com/kgheacock/tickr/pull/9)

## Goal

A single in-process Massive REST client, used only by the `worker` role's
backfill job, with a Redis-backed token bucket sized to Massive's free-tier
rate limit. Caller code awaits a budget slot before each request.

The daily price update (`GET /quote`) stays on the existing Finnhub client —
only the bootstrap backfill switches to Massive.

## Pre-reads

- [schema/massive.com/openapi.json](../schema/massive.com/openapi.json) — the
  Massive REST surface; only `GET /v2/aggs/ticker/{stocksTicker}/range/...`
  is used in v1.
- [TODO/06-backfill-and-daily-price.md](06-backfill-and-daily-price.md) — the
  backfill job this client serves; key implementation notes are in §2.
- [docs/09-open-questions.md](../docs/09-open-questions.md) — resolution of
  T2b (Finnhub `/stock/candle` gated); open items on Massive rate limit (T2c).

## Steps

1. **Generate types from Massive schema.** `npm run gen:massive` produces
   `apps/api/src/massive/massive.gen.ts` via `openapi-typescript` against the
   bundled schema at `schema/massive.com/openapi.json`. Commit the generated
   file. Add the script to the root `package.json` following the `gen:finnhub`
   pattern:
   ```
   "gen:massive": "openapi-typescript schema/massive.com/openapi.json -o apps/api/src/massive/massive.gen.ts && prettier --write apps/api/src/massive/massive.gen.ts"
   ```
2. **HTTP client.** `apps/api/src/massive/client.ts` exports
   `massiveGet<T>(path, query?)`. Reads `MASSIVE_API_KEY` from env; passes
   it as `Authorization: Bearer <key>` (Massive's auth shape). Times out at
   10 s. Retries on `ETIMEDOUT` / `ECONNRESET` (3×, exponential backoff
   250 ms → 2 s). Surfaces `429` as a typed `MassiveRateLimitError` without
   retrying — the bucket should have prevented it; a 429 means the bucket is
   mistuned.
3. **Token bucket in Redis.** `apps/api/src/massive/bucket.ts` exports
   `await acquire(): Promise<void>` using a Lua script for atomicity:
   ```
   key = "massive:bucket"
   capacity = N, refill = N per 60 s   (pin N after step 4)
   ```
   On exhaustion, the call sleeps until the next refill tick instead of
   throwing. Configurable via `MASSIVE_RPS_LIMIT` (default to probe result).
4. **Probe the endpoint.** Before wiring up the backfill job, run
   `scripts/probe-massive-candles.ts` to verify:
   - Free-tier history depth (expected: 2 years of daily bars).
   - Whether responses paginate (follow `next_url` or keep the window loop).
   - Actual rate limit (req/min or req/day) — set `MASSIVE_RPS_LIMIT` default.
   Pin findings in `docs/09-open-questions.md` (item T2c) before continuing.
5. **Wrap every call.** `massiveGet` calls `bucket.acquire()` first. No path
   bypasses the bucket. A unit test that mocks the bucket asserts exactly one
   `acquire` call per outbound request.
6. **Concurrency cap.** The backfill job can issue at most `N` Massive requests
   in flight at once (default 4, same as Finnhub). Reuse `p-limit` from
   `backfill.ts`.
7. **Update `backfill.ts`.** Replace the `finnhubGet('/stock/candle', ...)`
   call with `massiveGet(...)` targeting the Custom Bars endpoint
   (`/v2/aggs/ticker/{symbol}/range/1/day/{from}/{to}`). Key differences from
   the Finnhub shape:
   - `from`/`to` are `YYYY-MM-DD` strings (not Unix seconds).
   - Timestamps in `results[].t` are **milliseconds** — `new Date(t)` directly,
     no `× 1000`.
   - Response is `{ results: [{ t, o, h, l, c, v, vw, n }] }` — an array of
     objects, not Finnhub's parallel arrays. Rewrite `insertBars` accordingly.
   - Follow `next_url` if present within a window, or keep the existing
     date-window loop (pin strategy after step 4).
   - Lookback defaults to 2 years (`BACKFILL_LOOKBACK_DAYS=730`) to match
     the free-tier depth; window size becomes 365 days per call.
8. **Update `worker.ts`.** Validate `MASSIVE_API_KEY` at startup (same pattern
   as `FINNHUB_API_KEY`). Log and exit if absent.
9. **Tests.** `apps/api/test/massive/*.test.ts`:
   - Bucket honors steady-state rate limit (timer-mocked).
   - Bucket drains and refills correctly across a window boundary.
   - `429` from upstream bubbles up as `MassiveRateLimitError`.

## Files to create / modify

- `apps/api/src/massive/client.ts` — new
- `apps/api/src/massive/bucket.ts` — new
- `apps/api/src/massive/massive.gen.ts` — generated (`npm run gen:massive`)
- `apps/api/src/jobs/backfill.ts` — swap client call + response shape + lookback
- `apps/api/src/roles/worker.ts` — add `MASSIVE_API_KEY` startup validation
- `apps/api/test/massive/bucket.test.ts` — new
- `apps/api/test/massive/client.test.ts` — new
- `apps/api/test/jobs/backfill.test.ts` — update mock response shape
- `scripts/probe-massive-candles.ts` — new
- `package.json` — add `gen:massive` script
- `.env.example` — add `MASSIVE_API_KEY`; annotate `FINNHUB_API_KEY` as daily-price only
- `docs/09-open-questions.md` — close T2b; add T2c with probe findings

## Definition of done

- [ ] `npm run gen:massive` regenerates types deterministically from
      `schema/massive.com/openapi.json`.
- [ ] Probe findings documented in T2c; free-tier history depth and rate
      limit known; `MASSIVE_RPS_LIMIT` default set accordingly.
- [ ] Synthetic load of N calls completes in just over 60 s under the default
      bucket (timer-mocked test).
- [ ] No code path can call `fetch` against `api.massive.com` outside
      `client.ts` (grep check or lint rule in CI).
- [ ] `MASSIVE_API_KEY` never appears in logs.
- [ ] `runBackfill` completes for 5 seeded symbols against the real Massive API
      with `universe_symbol.backfilled = true` for all 5.
- [ ] `price_bar` contains daily OHLCV rows for each symbol spanning the
      available free-tier history.
- [ ] All existing tests pass (`npm test`).
