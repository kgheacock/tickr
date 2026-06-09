# 10 — Populating the Database

> How to take an **empty** database to a fully usable state: schema, the symbol
> universe, and historical price data. This is the bootstrap you run on a fresh
> machine, a new environment, or after `db:restore` of an empty snapshot.

The database is "populated" once three things exist:

1. **Schema** — tables created by migrations.
2. **Universe** — rows in `universe_symbol` (which tickers the platform tracks).
3. **Price history** — rows in `price_bar` for each symbol (`backfilled = true`).

The fastest path is the one-shot bootstrap script (§1); the rest of this doc
explains what it does and how to run each piece manually.

```bash
pnpm backfill        # migrate → seed universe → backfill prices, then exit
```

This single command is **idempotent** end to end — safe to run on an empty
database or to re-run any time. The worker also performs steps 1 and 3 on
startup, but it blocks forever afterward (for the daily-price cron), so it is not
a one-shot.

---

## 0. Prerequisites

- **Node 22** (`>=22.12.0`; see `.nvmrc` → `22.22.3`). The default `node` on
  some shells is older — use the pinned version.
- **Postgres + Redis** running. Locally these come up with the dev stack:
  ```bash
  pnpm dev          # docker compose: postgres, redis, api, worker, bot, caddy
  ```
  or just the data stores:
  ```bash
  docker compose -f compose/docker-compose.yml up -d postgres redis
  ```
- **Environment** — `.env` at the repo root (copy from `.env.example`). The
  variables that matter for population:

  | Variable | Needed for | Notes |
  |----------|-----------|-------|
  | `DATABASE_URL` | everything | e.g. `postgres://tickr:tickr@localhost:5432/tickr` |
  | `REDIS_URL` | worker / backfill locks | e.g. `redis://localhost:6379` |
  | `MASSIVE_API_KEY` | price backfill | worker exits without it |
  | `BACKFILL_START_DATE` | optional | only backfill from this date forward |

> The app code does **not** auto-load `.env` (env is injected by
> docker-compose). When running a script directly with `node`/`tsx`, pass
> `--env-file=.env` yourself, e.g.
> `node --env-file=.env --import tsx apps/api/src/db/seed-universe.ts`.

---

## 1. The easy path — `pnpm backfill`

One top-level command does everything needed to populate prices, in order, then
exits (`apps/api/src/jobs/run-backfill.ts`):

```bash
pnpm backfill
```

It runs:

1. `runMigrations()` — apply any pending migrations (no-op if up to date).
2. `seedUniverse()` — insert `data/sp500.csv` rows, `ON CONFLICT DO NOTHING`.
3. `runBackfill()` — fetch price history for every `universe_symbol` where
   `backfilled = false`, then flip them to `true`.

Every step is idempotent, so re-running only does outstanding work (e.g. a fresh
seed adds new tickers; backfill resumes wherever it left off). It loads the repo
`.env` automatically (`--env-file-if-exists`); make sure `MASSIVE_API_KEY`,
`DATABASE_URL`, and `REDIS_URL` are set there.

> ### Alternative: let the worker do it
> The worker role also runs migrations, bootstrap users, and backfill on startup
> (`apps/api/src/roles/worker.ts`), but it **blocks forever afterward** for the
> daily-price cron, so it is not a one-shot. It also does **not** seed the
> universe — on an empty DB it would log `"nothing to backfill"`. Use `pnpm
> backfill` for bootstrap; the worker is for running the platform.

---

## 2. Migrations (schema)

Migrations live in `apps/api/migrations/` and run via `node-pg-migrate`. The
worker and api both run them on startup, but you can run them standalone:

```bash
pnpm --filter @tickr/api db:migrate
```

This creates the platform core: `app_user`, `identity`, `universe_symbol`,
`price_bar` (see `02-data-model.md`).

---

## 3. Seed the universe

`universe_symbol` is populated from `apps/api/data/sp500.csv` (header
`symbol,name`, one row per ticker — the full S&P 500):

```bash
pnpm --filter @tickr/api db:seed:universe
```

- Inserts each CSV symbol with `backfilled = false`.
- Idempotent: `ON CONFLICT (symbol) DO NOTHING`, so re-running only adds new
  rows. Existing symbols (and their backfill status) are untouched.
- **To change the universe**, edit `data/sp500.csv` and re-run the seed. New
  rows arrive `backfilled = false` and get picked up on the next worker start.

Verify:

```bash
psql "$DATABASE_URL" -c \
  "SELECT backfilled, count(*) FROM universe_symbol GROUP BY backfilled;"
```

---

## 4. Backfill price history

After seeding, every new symbol has `backfilled = false`. The backfill job
(`apps/api/src/jobs/backfill.ts`) fills `price_bar` and flips the flag to `true`.
Run it standalone (this is the third step `pnpm backfill` performs):

```bash
pnpm --filter @tickr/api backfill    # migrate + seed + backfill, then exit
```

For each unbackfilled symbol it pulls daily bars from the Massive API in
`BACKFILL_WINDOW_DAYS` (365) windows back to `BACKFILL_LOOKBACK_DAYS` (730) days,
inserts them (`ON CONFLICT (symbol, ts) DO NOTHING`), then sets
`backfilled = true, backfilled_at = now()`. It is self-terminating and
idempotent — a symbol is never re-fetched once `true`.

Tuning knobs (env):

| Variable | Default | Effect |
|----------|---------|--------|
| `BACKFILL_CONCURRENCY` | `4` | symbols fetched in parallel |
| `BACKFILL_WINDOW_DAYS` | `365` | days per API request |
| `BACKFILL_LOOKBACK_DAYS` | `730` | how far back to fetch |
| `BACKFILL_START_DATE` | — | absolute start; overrides lookback |
| `BACKFILL_GAP_THRESHOLD_DAYS` | `7` | widen-history tolerance (see below) |

> A full S&P 500 backfill is ~500 symbols × ~2 windows = ~1,000 Massive API
> calls. The Massive REST client is throttled by a Redis token bucket to
> `MASSIVE_RPS_LIMIT` requests/min (default **5**), shared across all workers, so
> a full cold backfill takes **~3 hours** regardless of `BACKFILL_CONCURRENCY`.
> The job logs periodic progress (complete / remaining / ETA) as it runs.

### Widening history (extending the start date later)

A symbol is fetched only while `backfilled = false`, so simply lowering
`BACKFILL_START_DATE` / raising `BACKFILL_LOOKBACK_DAYS` does **not** re-fetch
older bars for symbols already marked `true` — they're skipped. To pick up the
new earlier range, `pnpm backfill` runs a **widen-history** step first
(`apps/api/src/jobs/widen-history.ts`, script-only — the worker never does this):
it flips `backfilled` back to `false` for any symbol whose oldest stored bar is
more than `BACKFILL_GAP_THRESHOLD_DAYS` after the requested start, so the next
backfill refills the gap.

```bash
BACKFILL_START_DATE=2018-01-01 pnpm backfill   # re-arms symbols with a front gap, then refetches
```

- The threshold absorbs weekend/holiday boundaries, so a normal re-run (same
  window) is a **no-op** — nothing is needlessly re-armed.
- It re-fetches the **whole** window for re-armed symbols (the recent overlap is
  ignored via `ON CONFLICT`), not just the missing slice — simpler, at the cost
  of some redundant rate-limited calls.
- **Caveat:** a symbol whose real history is shorter than the window (e.g. a
  recent IPO with no data that far back) looks permanently "short", so each
  explicit widen re-arms it and re-fetches an empty earlier range. This is the
  deliberate trade-off of deriving the decision from data instead of persisting
  a coverage watermark.

---

## 5. Verify a populated database

```bash
psql "$DATABASE_URL" <<'SQL'
SELECT count(*) AS symbols,
       count(*) FILTER (WHERE backfilled) AS backfilled
FROM universe_symbol;
SELECT count(*) AS price_bars FROM price_bar;
SQL
```

A healthy fresh DB shows ~500 symbols, all `backfilled = true`, and millions of
`price_bar` rows (≈500 symbols × ~500 trading days × ~26 intraday bars/day).

---

## TL;DR — empty database from scratch

```bash
# 0. infra + env
docker compose -f compose/docker-compose.yml up -d postgres redis
cp .env.example .env   # then fill in MASSIVE_API_KEY (+ DATABASE_URL/REDIS_URL)

# 1. schema + universe + price history, idempotent, then exit (~3h for a cold S&P 500 backfill)
pnpm backfill

# 2. run the platform (serves API + daily-price cron)
ROLE=worker pnpm --filter @tickr/api start
```
