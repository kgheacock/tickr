# 06 — Backfill + daily price update

> **Status:** pending • **Depends on:** 03, 05

## Goal

Load 5 years of 5-min OHLCV bars for every S&P 500 symbol (one-time
bootstrap) and append one daily close bar per symbol after each US market
close. Both jobs run only in the `worker` role, share the Finnhub bucket,
and are restart-safe.

## Pre-reads

- [docs/01-architecture.md §2.1](../docs/01-architecture.md#21-market-data-ingestion-rest-only)
  — both ingestion paths.
- [docs/08-deployment.md §5](../docs/08-deployment.md#5-scheduled--background-jobs)
  — cadence + idempotency requirements.
- [docs/09-open-questions.md T2b](../docs/09-open-questions.md#open-finnhub-questions)
  — unresolved: Finnhub `/stock/candle` per-call window and free-tier
  depth. Resolve this empirically as **the first thing** in implementation;
  if the per-call window is shorter than 5 years, the backfill loop has to
  paginate.

## Steps

1. **Resolve T2b.** Write a one-off probe script
   (`scripts/probe-finnhub-candles.ts`) that calls `GET /stock/candle?
   symbol=AAPL&resolution=5&from=...&to=...` for varying windows. Record:
   max window per call; whether `s` is `"ok"` or `"no_data"` past N years;
   any free-tier ceiling. Pin findings in
   [docs/09-open-questions.md](../docs/09-open-questions.md) before
   continuing.
2. **Bootstrap backfill job.** `apps/api/src/jobs/backfill.ts`:
   ```
   while exists universe_symbol with backfilled = false:
     batch = next 4 symbols (concurrency cap from item 05)
     for each symbol in parallel:
       for each window in 5y/W chunks (W from step 1):
         bars = finnhubGet('/stock/candle', { symbol, resolution: 5,
                                              from, to })
         bulk INSERT ... ON CONFLICT (symbol, ts) DO NOTHING into price_bar
       UPDATE universe_symbol SET backfilled = true,
              backfilled_at = now() WHERE symbol = $1
   ```
   Restart-safe by the `backfilled` flag; per-chunk insertion is idempotent
   via the PK conflict.
3. **Daily price update job.** `apps/api/src/jobs/daily-price.ts`:
   ```
   for each universe_symbol with backfilled = true:
     q = finnhubGet('/quote', { symbol })
     append one row to price_bar:
       ts    = today's market close (16:00 ET) in UTC
       open  = q.o, high = q.h, low = q.l, close = q.c
       volume = null  (Finnhub /quote doesn't return volume)
     ON CONFLICT (symbol, ts) DO NOTHING
   ```
   Uses the shared Finnhub bucket (60/min). 500 symbols ≈ 8.5 min.
   > **v1 approximation (O5):** `q.c` is Finnhub's current/delayed price,
   > not the official 4 PM close. `open/high/low` from `/quote` are
   > real-time snapshots, not true OHLC. This is documented and accepted
   > for v1; switching to `GET /stock/candle?resolution=D` is a v2 option.
4. **Scheduler.** Use `node-cron` in-process. Worker registers:
   - Backfill: runs at startup (and only if there are unbackfilled
     symbols); cancels itself when none remain.
   - Daily price: `0 30 21 * * 1-5` UTC (16:30 ET) Mon–Fri. Skipped on
     US market holidays via a static `apps/api/src/market/holidays.ts`
     (NYSE holiday list; refresh annually).
5. **Single-instance guard.** Both jobs grab a Redis lock
   (`finnhub:job:backfill`, `finnhub:job:daily-price`) with TTL 30 min.
   If a previous run is still alive, skip this firing. This protects
   against accidental two-worker deployments.
6. **Admin universe upsert.** `POST /admin/universe/upsert` (auth:admin)
   accepts `{ symbols: string[] }` and `INSERT … ON CONFLICT (symbol) DO
   NOTHING`. New rows start with `backfilled = false`, picked up by the
   next backfill sweep.
7. **Admin manual backfill.** `POST /admin/universe/backfill` with
   `{ symbol }` flips `backfilled` back to `false` for that symbol so the
   next sweep refills it. Useful for stuck or corrupted symbols.
8. **Tests.** Mock the Finnhub client; assert that:
   - Backfill skips already-backfilled symbols.
   - On crash mid-symbol, restart resumes (the symbol stays `backfilled =
     false`, partial rows survive via ON CONFLICT).
   - Daily-price re-run is a no-op (PK conflict).
   - Holiday days are skipped.

## Files to create

- `apps/api/src/jobs/backfill.ts`
- `apps/api/src/jobs/daily-price.ts`
- `apps/api/src/jobs/scheduler.ts`
- `apps/api/src/jobs/locks.ts`
- `apps/api/src/market/holidays.ts`
- `apps/api/src/routes/admin/universe.ts`
- `scripts/probe-finnhub-candles.ts`
- `apps/api/test/jobs/backfill.test.ts`
- `apps/api/test/jobs/daily-price.test.ts`

## Definition of done

- [ ] T2b is resolved and documented; backfill paginates accordingly.
- [ ] On a fresh DB with 5 seeded symbols, backfill completes and
      `universe_symbol.backfilled = true` for all 5; `price_bar` has
      `~5y × 252d × 78bars` rows per symbol (allowing for missing weekend
      data).
- [ ] Killing the worker mid-backfill and restarting completes without
      duplicate rows.
- [ ] Daily-price job after a successful run inserts exactly N new rows
      (one per backfilled symbol).
- [ ] Running daily-price twice in a row inserts zero new rows the second
      time.
- [ ] `POST /admin/universe/upsert` adds new symbols; the next backfill
      sweep picks them up.
- [ ] Holiday weekday: scheduler logs a skip; no Finnhub calls.
