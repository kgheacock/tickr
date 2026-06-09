# 08 — Snapshots + leaderboard

> **Status:** [removed](https://github.com/kgheacock/tickr/pull/25) • **Depends on:** 06, 07

## Goal

Daily EOD valuation snapshot of every portfolio, ranked into
`leaderboard_row`, cached in Redis for read load, and pushed to subscribed
WebSocket clients. The leaderboard the user sees is always the most recent
snapshot — never recomputed per request.

## Pre-reads

- [docs/04-game-mechanics.md §3](../docs/04-game-mechanics.md#3-snapshots--leaderboard)
  — snapshot + ranking flow.
- [docs/01-architecture.md §2.3](../docs/01-architecture.md#23-eod-valuation--leaderboard)
  — full pseudocode.
- [docs/08-deployment.md §5](../docs/08-deployment.md#5-scheduled--background-jobs)
  — cadence (right after the daily price update).

## Steps

1. **Snapshot job.** `apps/api/src/jobs/snapshot.ts`, scheduled to run as
   soon as the daily price update completes (item 06 chains them via a
   Redis pub/sub "daily-price.done" message). Single-instance via Redis
   lock `worker:job:snapshot`.
2. **Compute snapshots.** Single pass per portfolio in a CTE:
   ```sql
   WITH latest AS (
     SELECT DISTINCT ON (symbol) symbol, ts, close
     FROM price_bar
     ORDER BY symbol, ts DESC
   ),
   eq AS (
     SELECT p.id AS portfolio_id,
            p.cash,
            COALESCE(SUM(pos.quantity * latest.close), 0)::BIGINT
              AS positions_value,
            (p.cash + COALESCE(SUM(pos.quantity * latest.close), 0))::BIGINT
              AS equity
     FROM portfolio p
     LEFT JOIN position pos ON pos.portfolio_id = p.id
     LEFT JOIN latest      ON latest.symbol     = pos.symbol
     GROUP BY p.id, p.cash
   )
   INSERT INTO valuation_snapshot (id, portfolio_id, taken_at, cash,
                                   positions_value, equity)
   SELECT gen_random_uuid(), portfolio_id, $1, cash,
          positions_value, equity
   FROM eq
   ON CONFLICT (portfolio_id, taken_at) DO NOTHING
   RETURNING portfolio_id, equity;
   ```
   `$1` is the snapshot's `taken_at` — the day's market close in UTC,
   truncated to the day. Idempotent via the unique constraint.
3. **Rank into leaderboard_row.** In the same job, after the snapshot
   commits:
   ```sql
   INSERT INTO leaderboard_row (taken_at, portfolio_id, rank, equity,
                                return_pct)
   SELECT taken_at,
          portfolio_id,
          RANK() OVER (ORDER BY equity DESC) AS rank,
          equity,
          (equity::FLOAT - 100000000) / 100000000 AS return_pct
   FROM valuation_snapshot
   WHERE taken_at = $1
   ON CONFLICT (taken_at, portfolio_id) DO NOTHING;
   ```
   `RANK() OVER (ORDER BY equity DESC)` assigns the same rank to tied
   portfolios (G5b). Display queries use `ORDER BY rank, portfolio_id ASC`
   so equal-rank rows have a deterministic display order without breaking
   the rank value itself.
4. **Redis cache.** Write `leaderboard:latest` = JSON of the top-N rows
   (default N=100) and a `leaderboard:taken_at` key with the snapshot
   time. `GET /leaderboard` reads from Redis first; on miss it reads from
   `leaderboard_row` for the latest `taken_at` and warms the cache.
5. **WS push.** After cache warm, publish a Redis pub/sub event
   `ws:leaderboard.updated` carrying the same JSON. The WS gateway
   (item 09) subscribes and fans out to clients on the `leaderboard`
   topic.
6. **Snapshot lag exposure.** Update a Redis key
   `metric:lastSnapshotAt = <ISO ts>` for the ops endpoint and the
   `lastSnapshotAt` field on `GET /portfolios/:id` (item 07).
7. **Per-portfolio history.** `GET /portfolios/:id/history?limit=&cursor=`
   reads `valuation_snapshot` for the portfolio, ordered by `taken_at
   DESC`. Returns `{ takenAt, equity, returnPct }[]`.
8. **Tests.**
   - With 3 portfolios and 2 symbols, snapshot equity equals
     `cash + Σ qty × close` exactly.
   - Re-running the snapshot job for the same `taken_at` is a no-op
     (zero new rows).
   - Ranking with two portfolios tied on equity assigns the same `rank`
     and breaks by `portfolio_id` UUID order.
   - `GET /leaderboard` returns the cached payload; clearing Redis and
     calling again rebuilds it from `leaderboard_row`.

## Files to create

- `apps/api/src/jobs/snapshot.ts`
- `apps/api/src/routes/leaderboard.ts`
- `apps/api/src/cache/leaderboard.ts`
- `apps/api/src/events/publisher.ts` (Redis pub/sub helper)
- `apps/api/test/jobs/snapshot.test.ts`
- `apps/api/test/routes/leaderboard.test.ts`

## Definition of done

- [x] After the daily price update fires, the snapshot job runs within
      30 s and writes one `valuation_snapshot` row per portfolio.
- [x] `SELECT COUNT(*) FROM leaderboard_row WHERE taken_at = $latest`
      equals the number of portfolios.
- [x] `GET /leaderboard` returns `takenAt` matching the latest snapshot
      and rows ordered by equity DESC, tie-broken by portfolioId.
- [x] Redis `leaderboard:latest` is populated and used as a fast path
      (verified by p95 latency on the route).
- [x] `metric:lastSnapshotAt` updates after each run; `GET /admin/ops`
      reports it (item 10).
- [x] Running the snapshot job twice for the same `taken_at` doesn't
      create duplicate `valuation_snapshot` or `leaderboard_row` rows.
