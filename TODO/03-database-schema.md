# 03 — Database schema

> **Status:** done • **Depends on:** 01 • **PR:** [#6](https://github.com/kgheacock/tickr/pull/6)

## Goal

Create every v1 table, index, and the TimescaleDB hypertable; run them
through a migration tool that is safe in dev and prod. Schema must match
[docs/02-data-model.md](../docs/02-data-model.md) exactly.

## Pre-reads

- [docs/02-data-model.md §2, §4](../docs/02-data-model.md#2-core-entities-v1)
  — every v1 table, including the partial-unique-index fix for portfolio.
- [docs/02-data-model.md §2.10](../docs/02-data-model.md#210-price_bar-timescaledb)
  — the hypertable + compression policy.

## Steps

1. **Pick a migration tool.** Use `node-pg-migrate` (SQL-first,
   timestamped files, no ORM coupling). Add it to `apps/api`:
   ```
   apps/api/migrations/
     1700000000000_init.sql
     1700000000001_timescale.sql
     1700000000002_compression.sql
   ```
2. **Write `1700000000000_init.sql`.** Verbatim from
   [docs/02-data-model.md](../docs/02-data-model.md):
   `app_user`, `identity`, `algo`, `portfolio` (+ both partial unique
   indexes), `position`, `trade_order`, `fill`, `valuation_snapshot`,
   `leaderboard_row`, `universe_symbol`. Foreign keys exactly as documented
   (e.g. `position.symbol REFERENCES universe_symbol(symbol)`).
3. **Write `1700000000001_timescale.sql`.** `CREATE EXTENSION IF NOT EXISTS
   timescaledb`; create `price_bar` table; `SELECT create_hypertable(
   'price_bar', 'ts')`. Separate file because the extension must exist
   before the hypertable.
4. **Write `1700000000002_compression.sql`.** Enable compression and add
   the 7-day policy as in [docs/02-data-model.md §2.10](../docs/02-data-model.md#210-price_bar-timescaledb).
5. **Migration runner entrypoint.** `apps/api/src/db/migrate.ts` invoked
   via `npm run db:migrate` (also runs in the `api` container's startup
   for dev; production runs it as a one-shot `docker compose run --rm api
   npm run db:migrate` before bringing api up — see item 12).
6. **Connection pool.** `apps/api/src/db/pool.ts` exports a `pg.Pool` keyed
   off `DATABASE_URL`. Single shared pool per process. Use `parseInt8` to
   keep cents as `BigInt`-safe numbers (or `bigint` strings) — pick one and
   stick with it. **Recommend:** treat cents as JS `number` since
   `Number.MAX_SAFE_INTEGER` ≈ 9e15 ≫ $90T in cents; document this choice
   in `apps/api/src/db/types.ts`.
7. **Seed `universe_symbol`.** `apps/api/src/db/seed-universe.ts` upserts
   the current S&P 500 list from a CSV bundled in the repo
   (`apps/api/data/sp500.csv`). Sets `backfilled = false`. Idempotent.
   Source the CSV from a snapshot (commit it; don't fetch live in v1).
8. **Tests.** A test runner (Vitest) that spins up an ephemeral Postgres
   via `testcontainers` and runs every migration; assert key constraints
   (e.g. inserting two `(user_id, NULL)` portfolio rows raises a unique
   violation; inserting an `order` for an unknown `universe_symbol` raises
   a FK violation).

## Files to create

- `apps/api/migrations/1700000000000_init.sql`
- `apps/api/migrations/1700000000001_timescale.sql`
- `apps/api/migrations/1700000000002_compression.sql`
- `apps/api/src/db/migrate.ts`
- `apps/api/src/db/pool.ts`
- `apps/api/src/db/types.ts`
- `apps/api/src/db/seed-universe.ts`
- `apps/api/data/sp500.csv`
- `apps/api/test/db/schema.test.ts`

## Definition of done

- [x] `npm run db:migrate` is idempotent (running it twice is a no-op).
- [x] `psql -c '\dt'` lists every v1 table from §2 of the data-model doc.
- [x] `psql -c "SELECT hypertable_name FROM timescaledb_information.hypertables"`
      includes `price_bar`.
- [x] Two `INSERT INTO portfolio (user_id, algo_id, cash) VALUES
      ('<U>', NULL, 100000000)` calls — the second raises a unique violation.
- [x] Inserting `position` with a symbol absent from `universe_symbol`
      raises a FK violation.
- [x] `npm run db:seed:universe` inserts ~500 rows; re-running is a no-op.
- [x] Vitest passes against an ephemeral Postgres in CI.
