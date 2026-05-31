# 13 — Switch backfill source to Massive (formerly Polygon.io)

> **Status:** pending • **Depends on:** 06

## Goal

Replace the `runBackfill` job's Finnhub `/stock/candle` calls with Massive
(formerly Polygon.io). Finnhub's free tier blocked `/stock/candle` on
2025-04-15 (HTTP 403 for all resolutions). Massive's free tier provides 2
years of daily OHLCV bars, which is sufficient for v1.

## Background

- T2b (docs/09-open-questions.md): `/stock/candle` is premium-only on Finnhub.
  The daily price job (`GET /quote`) stays on Finnhub — it is free and working.
- The existing `backfill.ts` logic (chunked windows, `unnest` bulk insert,
  `ON CONFLICT DO NOTHING` idempotency, `backfilled` flag) is correct and
  reusable; only the HTTP client call changes.
- Massive free tier: daily bars, up to 2 years of history, rate limit TBD.

## Steps

1. **Sign up / get credentials.** Obtain a Massive API key. Record the base
   URL and auth header scheme in `.env.example` as `MASSIVE_API_KEY`.

2. **Probe the endpoint.** Write (or adapt) `scripts/probe-massive-candles.ts`
   to verify:
   - Endpoint path and query parameters for daily OHLCV bars.
   - How many years of history are available on the free tier.
   - Whether the response paginates or returns all bars in one call.
   - Rate limit (req/min or req/day).
   - Pin findings in docs/09-open-questions.md before continuing.

3. **Add a Massive client.** `apps/api/src/massive/client.ts`:
   - Mirror the structure of `finnhub/client.ts` — `massiveGet<T>(path, query)`.
   - Share the existing Redis token bucket or add a separate `massive:bucket`
     key sized to the actual rate limit.
   - The Massive client does NOT need the worker-role guard that
     `finnhub/index.ts` has; import it directly in `backfill.ts`.

4. **Update `backfill.ts`.** Replace the `finnhubGet('/stock/candle', ...)`
   call with the Massive equivalent. The `insertBars` helper and all
   surrounding logic stay unchanged.

5. **Update `worker.ts`** if the Massive client needs a different bootstrap
   (e.g., validating `MASSIVE_API_KEY` at startup).

6. **Update tests.** `apps/api/test/jobs/backfill.test.ts` mocks `fetch`
   globally; swap the response shape to match Massive's candle response.

7. **Update docs.** Close T2b in docs/09-open-questions.md with the Massive
   findings. Update the `backfill.ts` header comment.

## Files to create / modify

- `apps/api/src/massive/client.ts` — new
- `apps/api/src/jobs/backfill.ts` — swap client call
- `apps/api/src/roles/worker.ts` — add key validation if needed
- `apps/api/test/jobs/backfill.test.ts` — update mock response shape
- `scripts/probe-massive-candles.ts` — new
- `.env.example` — add `MASSIVE_API_KEY`
- `docs/09-open-questions.md` — close T2b

## Definition of done

- [ ] Probe findings documented; free-tier history depth and rate limit known.
- [ ] `runBackfill` completes for 5 seeded symbols against the real Massive API
      with `universe_symbol.backfilled = true` for all 5.
- [ ] `price_bar` contains daily OHLCV rows for each symbol spanning the
      available free-tier history.
- [ ] All existing tests pass (`npm test`).
- [ ] `MASSIVE_API_KEY` added to `.env.example`; `FINNHUB_API_KEY` note updated
      to clarify it is now only used for the daily price job.
