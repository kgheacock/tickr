# 06 — Backfill + daily price update

> **Status:** [done](https://github.com/kgheacock/tickr/pull/9) • **Depends on:** 03, 05, 13

## Goal

Bootstrap `price_bar` for every S&P 500 symbol using the Massive REST API,
then append intraday bars each post-close session. All jobs run only in the
`worker` role and are restart-safe.

### Backfill strategy

| Phase | Source | Scope | How |
|---|---|---|---|
| 1 — historical | Massive REST API | LOOKBACK_DAYS (~2y) back to present | Worker backfill job; rate-limited via Redis token bucket (see TODO/13) |
| 2 — live updates | Massive REST API | Trailing ~4 days, daily post-close | Worker cron job at 21:30 UTC Mon–Fri |

The `universe_symbol.backfilled` flag coordinates both: the backfill job sets
it when a symbol is fully fetched; the session-update job only runs for
`backfilled = true` symbols.

## Pre-reads

- [docs/01-architecture.md §2.1](../docs/01-architecture.md#21-market-data-ingestion-rest-only)
  — ingestion paths.
- [docs/08-deployment.md §5](../docs/08-deployment.md#5-scheduled--background-jobs)
  — cadence + idempotency requirements.
- [docs/09-open-questions.md T2c](../docs/09-open-questions.md#open-market-data-questions)
  — Massive free-tier depth and rate limit (5 req/min; ~June 2024 cutoff).
    Resolved; `MASSIVE_RPS_LIMIT=5` confirmed.
- [TODO/13-massive-client.md](13-massive-client.md) — Massive HTTP client and
  Redis token bucket.

## Steps

1. ~~**Resolve T2c.**~~ Resolved (2026-06-01). See
   [docs/09-open-questions.md T2c](../docs/09-open-questions.md#open-market-data-questions).
2. **Phase 1 — Massive historical backfill.** `apps/api/src/jobs/backfill.ts`:
   ```
   while exists universe_symbol with backfilled = false:
     batch = next 4 symbols (concurrency cap)
     for each symbol in parallel:
       for each window in BACKFILL_START_DATE→today in 365d chunks:
         bars = massiveGet('/v2/aggs/ticker/{symbol}/range/1/day', { from, to })
         bulk INSERT ... ON CONFLICT (symbol, ts) DO NOTHING into price_bar
       UPDATE universe_symbol SET backfilled = true,
              backfilled_at = now() WHERE symbol = $1
   ```
   Restart-safe by the `backfilled` flag; per-chunk insertion is idempotent
   via the PK conflict. See TODO/13 for the Massive client.
3. **Phase 2 — post-close session update.** `apps/api/src/jobs/daily-price.ts`:
   ```
   for each universe_symbol with backfilled = true:
     q = finnhubGet('/quote', { symbol })
     append one row to price_bar:
       ts    = today's market close (16:00 ET) in UTC
       open  = q.o, high = q.h, low = q.l, close = q.c
       volume = null  (Finnhub /quote doesn't return volume)
     ON CONFLICT (symbol, ts) DO NOTHING
   ```
   Uses the Finnhub bucket (60/min). 500 symbols ≈ 8.5 min.
   > **v1 approximation (O5):** `q.c` is Finnhub's current/delayed price,
   > not the official 4 PM close. `open/high/low` from `/quote` are
   > real-time snapshots, not true OHLC. This is documented and accepted
   > for v1.
4. **Scheduler.** Use `node-cron` in-process. Worker registers:
   - Backfill: runs at startup (and only if there are unbackfilled
     symbols); cancels itself when none remain.
   - Daily price: `0 30 21 * * 1-5` UTC (16:30 ET) Mon–Fri. Skipped on
     US market holidays via a static `apps/api/src/market/holidays.ts`
     (NYSE holiday list; refresh annually).
5. **Single-instance guard.** Both jobs grab a Redis lock
   (`worker:job:backfill`, `worker:job:daily-price`) with TTL 30 min.
   If a previous run is still alive, skip this firing. This protects
   against accidental two-worker deployments.
6. **Admin universe upsert.** `POST /admin/universe/upsert` (auth:admin)
   accepts `{ symbols: string[] }` and `INSERT … ON CONFLICT (symbol) DO
   NOTHING`. New rows start with `backfilled = false`, picked up by the
   next backfill sweep.
7. **Admin manual backfill.** `POST /admin/universe/backfill` with
   `{ symbol }` flips `backfilled` back to `false` for that symbol so the
   next sweep refills it. Useful for stuck or corrupted symbols.
8. **Tests.** Mock the market data clients; assert that:
   - Backfill skips already-backfilled symbols.
   - On crash mid-symbol, restart resumes (the symbol stays `backfilled =
     false`, partial rows survive via ON CONFLICT).
   - Daily-price re-run is a no-op (PK conflict).
   - Holiday days are skipped.

## Files to create / modify

- `apps/api/src/jobs/backfill.ts` — add `BACKFILL_START_DATE` support
- `apps/api/src/jobs/daily-price.ts` — new
- `apps/api/src/jobs/scheduler.ts` — new
- `apps/api/src/jobs/locks.ts` — new
- `apps/api/src/market/holidays.ts` — new
- `apps/api/src/routes/admin/universe.ts` — new
- `apps/api/test/jobs/backfill.test.ts` — update for `BACKFILL_START_DATE`
- `apps/api/test/jobs/daily-price.test.ts` — new

## Definition of done

- [ ] T2c is resolved and documented (done — see 09-open-questions.md).
- [ ] On a fresh DB with 5 seeded symbols, the Massive backfill completes and
      `universe_symbol.backfilled = true` for all 5; `price_bar` has
      `~2y × 252d × ~26bar` intraday rows per symbol.
- [ ] Killing the worker mid-backfill and restarting completes without
      duplicate rows.
- [ ] Daily-price job after a successful run inserts exactly N new rows
      (one per backfilled symbol).
- [ ] Running daily-price twice in a row inserts zero new rows the second
      time.
- [ ] `POST /admin/universe/upsert` adds new symbols; the next backfill
      sweep picks them up.
- [ ] Holiday weekday: scheduler logs a skip; no market data calls.
