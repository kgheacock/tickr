# 06 — Backfill + daily price update

> **Status:** done • **Depends on:** 03, 05, 13, 14 • **PR:** [#9](https://github.com/kgheacock/tickr/pull/9)

## Goal

Bootstrap `price_bar` for every S&P 500 symbol using a **two-phase backfill**,
then append one daily close bar per symbol after each US market close via
Finnhub `GET /quote`. All three sources run only in the `worker` role (or as
the Kaggle CLI script for phase 1) and are restart-safe.

### Backfill strategy

| Phase | Source | Scope | How |
|---|---|---|---|
| 1 — historical bulk | Kaggle CSV dataset | Full history up to ~2024-07-06 | `npm run kaggle:backfill` (one-time CLI script; see TODO/14) |
| 2 — gap fill | Massive REST API | 2024-07-06 → present | Worker backfill job with `BACKFILL_START_DATE=2024-07-06`; rate-limited via Redis token bucket (see TODO/13) |
| 3 — live updates | Finnhub `/quote` | Daily after market close | Worker cron job (unchanged) |

Run phases in order. The `universe_symbol.backfilled` flag coordinates all
three: the Kaggle script sets it after each symbol; the Massive job skips
symbols already marked `backfilled = true` that were fully covered by Kaggle.

## Pre-reads

- [docs/01-architecture.md §2.1](../docs/01-architecture.md#21-market-data-ingestion-rest-only)
  — ingestion paths.
- [docs/08-deployment.md §5](../docs/08-deployment.md#5-scheduled--background-jobs)
  — cadence + idempotency requirements.
- [docs/09-open-questions.md T2c](../docs/09-open-questions.md#open-market-data-questions)
  — Massive free-tier depth and rate limit (5 req/min; ~June 2024 cutoff).
    Resolved; `MASSIVE_RPS_LIMIT=5` confirmed.
- [TODO/14-kaggle-client.md](14-kaggle-client.md) — Kaggle download + CSV
  streaming parser; `insertBars` shared helper.
- [TODO/13-massive-client.md](13-massive-client.md) — Massive HTTP client and
  Redis token bucket.

## Steps

1. ~~**Resolve T2c.**~~ Resolved (2026-06-01). See
   [docs/09-open-questions.md T2c](../docs/09-open-questions.md#open-market-data-questions).
2. **Phase 1 — Kaggle bulk import.** Follow TODO/14. Run
   `npm run kaggle:backfill` once against the real Kaggle API. The script
   streams `history.csv` from the archive, inserts OHLCV bars for every
   `universe_symbol` present in the dataset, and sets `backfilled = true`
   per symbol.
   ```
   npx tsx scripts/kaggle-backfill.ts
   ```
   Restart-safe: already-backfilled symbols are skipped on re-run via
   `ON CONFLICT DO NOTHING`; the `backfilled` flag prevents re-processing.
3. **Phase 2 — Massive gap fill.** `apps/api/src/jobs/backfill.ts`:
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
   Set `BACKFILL_START_DATE=2024-07-06` so Massive only covers the gap.
   Restart-safe by the `backfilled` flag; per-chunk insertion is idempotent
   via the PK conflict. See TODO/13 for the Massive client and TODO/14 step 7
   for the `BACKFILL_START_DATE` env-var plumbing.
4. **Phase 3 — daily price update job.** `apps/api/src/jobs/daily-price.ts`:
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
5. **Scheduler.** Use `node-cron` in-process. Worker registers:
   - Backfill: runs at startup (and only if there are unbackfilled
     symbols); cancels itself when none remain.
   - Daily price: `0 30 21 * * 1-5` UTC (16:30 ET) Mon–Fri. Skipped on
     US market holidays via a static `apps/api/src/market/holidays.ts`
     (NYSE holiday list; refresh annually).
6. **Single-instance guard.** Both jobs grab a Redis lock
   (`worker:job:backfill`, `worker:job:daily-price`) with TTL 30 min.
   If a previous run is still alive, skip this firing. This protects
   against accidental two-worker deployments.
7. **Admin universe upsert.** `POST /admin/universe/upsert` (auth:admin)
   accepts `{ symbols: string[] }` and `INSERT … ON CONFLICT (symbol) DO
   NOTHING`. New rows start with `backfilled = false`, picked up by the
   next backfill sweep.
8. **Admin manual backfill.** `POST /admin/universe/backfill` with
   `{ symbol }` flips `backfilled` back to `false` for that symbol so the
   next sweep refills it. Useful for stuck or corrupted symbols.
9. **Tests.** Mock the market data clients; assert that:
   - Backfill skips already-backfilled symbols.
   - On crash mid-symbol, restart resumes (the symbol stays `backfilled =
     false`, partial rows survive via ON CONFLICT).
   - Daily-price re-run is a no-op (PK conflict).
   - Holiday days are skipped.

## Files to create / modify

- `apps/api/src/jobs/backfill.ts` — add `BACKFILL_START_DATE` support (see TODO/14 step 7)
- `apps/api/src/jobs/daily-price.ts` — new
- `apps/api/src/jobs/scheduler.ts` — new
- `apps/api/src/jobs/locks.ts` — new
- `apps/api/src/market/holidays.ts` — new
- `apps/api/src/routes/admin/universe.ts` — new
- `apps/api/test/jobs/backfill.test.ts` — update for `BACKFILL_START_DATE`
- `apps/api/test/jobs/daily-price.test.ts` — new
- *(Kaggle files in TODO/14)*

## Definition of done

- [ ] T2c is resolved and documented (done — see 09-open-questions.md).
- [ ] `npm run kaggle:backfill` on a fresh DB with 5 seeded symbols completes;
      `universe_symbol.backfilled = true` for all 5; `price_bar` contains
      bars from the dataset's full date range for each symbol.
- [ ] Running the Kaggle script a second time inserts zero new rows.
- [ ] With `BACKFILL_START_DATE=2024-07-06`, the worker Massive backfill job
      picks up the 5 symbols (still `backfilled = false` from the worker's
      perspective — or re-tested by temporarily resetting the flag), fetches
      only bars from that date forward, and sets `backfilled = true`.
- [ ] On a fresh DB with 5 seeded symbols (Kaggle skipped), the Massive
      backfill alone completes and `universe_symbol.backfilled = true` for
      all 5; `price_bar` has `~2y × 252d × 1bar` rows per symbol.
- [ ] Killing the worker mid-backfill and restarting completes without
      duplicate rows.
- [ ] Daily-price job after a successful run inserts exactly N new rows
      (one per backfilled symbol).
- [ ] Running daily-price twice in a row inserts zero new rows the second
      time.
- [ ] `POST /admin/universe/upsert` adds new symbols; the next backfill
      sweep picks them up.
- [ ] Holiday weekday: scheduler logs a skip; no market data calls.
