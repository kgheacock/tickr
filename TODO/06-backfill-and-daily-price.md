# 06 — Backfill + daily price update

> **Status:** pending • **Depends on:** 03, 05

## Goal

Load 2 years of daily OHLCV bars for every S&P 500 symbol via Massive
(one-time bootstrap) and append one daily close bar per symbol after each
US market close via Finnhub `GET /quote`. Both jobs run only in the `worker`
role and are restart-safe. Each job uses its own Redis token bucket (see
TODO/13 for the Massive client; item 05 for the Finnhub client).

## Pre-reads

- [docs/01-architecture.md §2.1](../docs/01-architecture.md#21-market-data-ingestion-rest-only)
  — both ingestion paths.
- [docs/08-deployment.md §5](../docs/08-deployment.md#5-scheduled--background-jobs)
  — cadence + idempotency requirements.
- [docs/09-open-questions.md T2c](../docs/09-open-questions.md#open-market-data-questions)
  — open: Massive rate limit and pagination behavior. Resolve via the probe
  script in TODO/13 step 4 **before** implementing the backfill loop.

## Steps

1. **Resolve T2c.** Run `scripts/probe-massive-candles.ts` (see TODO/13
   step 4) to determine Massive's rate limit and pagination behavior. Pin
   findings in [docs/09-open-questions.md](../docs/09-open-questions.md)
   (T2c) before continuing.
2. **Bootstrap backfill job.** `apps/api/src/jobs/backfill.ts`:
   ```
   while exists universe_symbol with backfilled = false:
     batch = next 4 symbols (concurrency cap)
     for each symbol in parallel:
       for each window in 2y/365d chunks:
         bars = massiveGet('/v2/aggs/ticker/{symbol}/range/1/day', { from, to })
         bulk INSERT ... ON CONFLICT (symbol, ts) DO NOTHING into price_bar
       UPDATE universe_symbol SET backfilled = true,
              backfilled_at = now() WHERE symbol = $1
   ```
   Restart-safe by the `backfilled` flag; per-chunk insertion is idempotent
   via the PK conflict. See TODO/13 for the Massive client and response
   shape (millisecond timestamps, object array, `next_url` pagination).
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

## Files to create

- `apps/api/src/jobs/backfill.ts`
- `apps/api/src/jobs/daily-price.ts`
- `apps/api/src/jobs/scheduler.ts`
- `apps/api/src/jobs/locks.ts`
- `apps/api/src/market/holidays.ts`
- `apps/api/src/routes/admin/universe.ts`
- `scripts/probe-massive-candles.ts`
- `apps/api/test/jobs/backfill.test.ts`
- `apps/api/test/jobs/daily-price.test.ts`

## Definition of done

- [ ] T2c is resolved and documented; backfill paginates or windows accordingly.
- [ ] On a fresh DB with 5 seeded symbols, backfill completes and
      `universe_symbol.backfilled = true` for all 5; `price_bar` has
      `~2y × 252d × 1bar` rows per symbol (allowing for non-trading days).
- [ ] Killing the worker mid-backfill and restarting completes without
      duplicate rows.
- [ ] Daily-price job after a successful run inserts exactly N new rows
      (one per backfilled symbol).
- [ ] Running daily-price twice in a row inserts zero new rows the second
      time.
- [ ] `POST /admin/universe/upsert` adds new symbols; the next backfill
      sweep picks them up.
- [ ] Holiday weekday: scheduler logs a skip; no market data calls.
