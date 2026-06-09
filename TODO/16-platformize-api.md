# 16 — Platformize the API (game → market-data platform)

> **Status:** [done](https://github.com/kgheacock/tickr/pull/25) • **Depends on:** 03, 04, 06, 09

## Goal

Pivot tickr from a **stock-trading game** to a **market-data + returns
platform**. The game loop (one portfolio per user, perpetual leaderboard,
house bot) is dropped. What survives is the data corpus core plus the
**authenticated live-update spine**: a registry of stocks (`universe_symbol`),
a continuously-updating OHLCV time series (`price_bar`), the ingestion cron,
SSO auth + sessions + CSRF, and a refocused WebSocket.

On top of that core, expose four capabilities:

1. **A cron** that keeps a continuously-updating time-series dataset for a
   given corpus of stocks (refocus, not rebuild — backfill + daily-price
   already do this).
2. **`POST /api/v1/evaluate`** — evaluate the returns of a *given series of
   orders*, replayed against historical prices. **Stateless**: no portfolio,
   no persistence.
3. **`GET /api/v1/universe`** — return the corpus of stocks.
4. **`GET /api/v1/prices`** — return the pricing history of a corpus, using
   the best available price data.

The WebSocket is **refocused** (not removed) to push live updates for the
endpoints above. This item delivers the spine only: **auth + CSRF + sessions
+ a working WS connection that logs live updates to the console.** No display
logic — rendering is deferred (see [18-display-logic.md](18-display-logic.md),
and [11-frontend.md](11-frontend.md), both of which depend on this item).

This item supersedes the game scope in items 07, 08, and the leaderboard/
portfolio parts of 09 and 11.

## Pre-reads

- [docs/00-overview.md](../docs/00-overview.md) — the game framing being
  replaced. Read to know what's leaving.
- [docs/02-data-model.md §2.9, §2.10](../docs/02-data-model.md#29-universe_symbol)
  — `universe_symbol` + `price_bar`, the data tables that survive.
- [docs/03-api.md §5, §7](../docs/03-api.md#5-market-data-read-only-passthrough)
  — the `/symbols`/`/quotes` shapes the read endpoints evolve from, and the
  WS contract the refocus reworks.
- [docs/05-auth.md](../docs/05-auth.md) and `apps/api/src/auth/` — the auth
  that **stays**.
- `apps/api/src/jobs/backfill.ts`, `daily-price.ts`, `scheduler.ts` — the
  ingestion the cron keeps.
- `apps/api/src/ws/`, `events/publisher.ts` — the WS gateway being refocused.
- [07-trading-engine.md](07-trading-engine.md) — the fill/validation/money
  logic the **stateless** evaluator reuses (without the DB transaction).

## Design decisions (pin these before coding)

- **D1 — "Corpus" = the universe set.** There is exactly one corpus: the
  rows of `universe_symbol`. We do **not** build a multi-corpus registry. The
  only weighted-subset abstraction is the ETF (item 17). "A corpus" means "a
  list of symbols, each of which must be in `universe_symbol`."
- **D2 — Pricing resolution stays daily.** The implemented backfill fetches
  `/v2/aggs/ticker/{sym}/range/1/day/...` over a 730-day lookback; daily-price
  appends one EOD bar/symbol/day. Resolution is **one daily bar per symbol**.
  (Note: data-model §2.10 claims "5 years of 5-min bars" — stale vs. the code;
  correct it to "≈2 years of daily bars" or file it in
  [docs/09-open-questions.md](../docs/09-open-questions.md). Don't inherit
  both.)
- **D3 — "Continuously updating" = the existing daily EOD cadence.** Daily
  EOD satisfies "continuously updating" for a daily-resolution dataset. No
  intraday ingestion here; keep the `0 30 21 * * 1-5` cron.
- **D4 — "Best available price data" is a write-time precedence rule.**
  `price_bar` remains the sole source of truth. The cron decides, per
  (symbol, day), which provider's bar wins when both Massive (deep history)
  and Finnhub (recent/daily) cover it. `/prices` just reads `price_bar`. See
  step 6.
- **D5 — Evaluation fills at point-in-time, not latest.** The live engine
  (07) fills at the *latest* close via `latestPrice()`. The stateless
  evaluator fills each order at the `price_bar.close` **at or before that
  order's timestamp**. See step 5.

## A. Remove with prejudice

Delete the game-only surface. The table drops go in one new migration
(step 7). **Auth, the WebSocket, and the frontend are NOT removed** — see §B.

- **Portfolios / positions / orders / fills** (item 07): `src/trading/`
  (except the reusable money/validation helpers — see §B), `routes/portfolios/`
  (`view.ts`, `view-query.ts`, `orders.ts`, `cancel.ts`, `history.ts`,
  `middleware.ts`, `schema.ts`); the `portfolio`, `position`, `trade_order`,
  `fill` tables.
- **Snapshots / leaderboard** (item 08): `jobs/snapshot.ts`, `cache/`,
  `routes/leaderboard.ts`; the `valuation_snapshot` and `leaderboard_row`
  tables; the snapshot chain in `scheduler.ts`. Leaderboards are premature.
- **Bot / algo** (item 07 seeding): `src/bot/`, `roles/bot.ts`, the `bot`
  ROLE branch in `index.ts`; the `algo` table.
- **Game admin** (item 10): keep `routes/admin/universe.ts` (the corpus stays
  admin-managed); drop the ops view that reports snapshot lag / leaderboard
  health.

After removal, `portfolio`, `position`, `trade_order`, `fill`,
`valuation_snapshot`, `leaderboard_row`, and `algo` are gone. `app_user`,
`identity`, `universe_symbol`, and `price_bar` remain.

## B. What stays (the platform core)

- **Auth / SSO / sessions / CSRF** (item 04): `apps/api/src/auth/`,
  `routes/auth/`, `routes/me.ts`, `@fastify/cookie` session wiring; the
  `app_user` and `identity` tables. Auth gates the WS connection (and may
  gate the endpoints — decide at impl). `/me` drops `portfolioId` (no
  portfolios) but keeps user + identities + `csrfToken`.
- **WebSocket** (item 09), **refocused**: `apps/api/src/ws/`,
  `events/publisher.ts`. Repurpose topics from game state to platform data
  (step 4).
- `universe_symbol` + `price_bar` (+ TimescaleDB hypertable & compression).
- `jobs/backfill.ts`, `daily-price.ts`, `insertBars.ts`, `locks.ts`,
  `market/holidays.ts`, and the (simplified) `scheduler.ts`.
- The Massive + Finnhub clients (`src/massive/`, `src/finnhub/`).
- `db/migrate.ts`, `db/pool.ts`, `db/seed-universe.ts`.
- The **pure** trading helpers worth salvaging for the evaluator:
  `trading/money.ts` (cents arithmetic, decimal.js) and the validation
  predicates — lifted out of the DB-transaction code.
- `ROLE` collapses to two: `api` (HTTP + WS) and `worker` (cron). Drop `bot`.

## Steps

1. **Strip the game surface.** Apply §A: delete the listed dirs/files/routes
   and the `bot` role. Keep the auth registrations in `roles/api.ts`; remove
   the portfolio/leaderboard route registrations. Update `/me` to drop
   `portfolioId`.
2. **`GET /api/v1/universe`** — the corpus. Evolve `/symbols` (03-api §5):
   ```ts
   interface UniverseResponse {
     items: Array<{
       symbol: string;
       backfilled: boolean;        // false → no price history yet
       backfilledAt: string | null;
       firstBarAt: string | null;  // earliest price_bar.ts for the symbol
       lastBarAt: string | null;   // latest price_bar.ts
     }>;
   }
   ```
   Optional `?backfilled=true` filter.
3. **`GET /api/v1/prices`** — pricing history for a corpus. Reads `price_bar`
   only (D4).
   ```
   GET /api/v1/prices?symbols=AAPL,MSFT&from=2024-01-01&to=2024-06-01
   ```
   ```ts
   interface PricesResponse {
     from: string; to: string;     // resolved window
     series: Record<string, Array<{
       ts: string;                 // bar date (UTC)
       open: number; high: number; // cents
       low: number;  close: number;
       volume: number | null;
     }>>;
     missing: string[];            // requested symbols not in universe / no bars
   }
   ```
   - Each symbol must be in `universe_symbol` (else → `missing`, don't fail
     the whole request).
   - Cap corpus size and window (e.g. ≤ 100 symbols, ≤ 2y); document the cap.
   - Hits the `WHERE symbol = $1 AND ts BETWEEN $2 AND $3` hypertable hot path.
4. **Refocus the WebSocket** (the live spine). One **authenticated** socket
   at `/ws` (reuse the auth from §B). Replace the game topics with
   platform-data topics:
   ```ts
   type WsTopic =
     | { kind: "universe" }                 // corpus membership / backfill state changes
     | { kind: "prices"; symbols: string[] };// new bars for the named symbols

   type WsServerMessage =
     | { type: "universe.updated"; data: UniverseResponse }
     | { type: "prices.updated"; asOf: string;
         series: PricesResponse["series"] }
     | { type: "error"; error: { code: string; message: string } };
   ```
   - The daily cron (step 5/D3) publishes `prices.updated` after it appends
     EOD bars, and `universe.updated` when backfill flips a symbol. Reuse
     `events/publisher.ts` as the publish path.
   - `evaluate` is a stateless request/response (step 5) and is **not** a
     live topic.
   - **No display logic in this item.** The only client deliverable is a
     minimal reference client (`apps/api/scripts/ws-client.ts` or similar)
     that authenticates, opens `/ws`, subscribes, and **logs each
     `WsServerMessage` to the console.** This proves the spine end-to-end;
     rendering is item 18 / item 11.
5. **`POST /api/v1/evaluate`** — stateless returns evaluation. **No DB
   writes.**
   ```ts
   interface EvaluateRequest {
     startingCash: number;         // cents
     orders: Array<{
       symbol: string;
       side: "buy" | "sell";
       quantity: number;           // NUMERIC(20,8); > 0
       at: string;                 // ISO-8601 — when this order executes
     }>;
   }
   interface EvaluateResponse {
     orders: Array<{               // echo with the resolved fill
       /* ...input... */
       fillPrice: number | null;   // cents/share at-or-before `at`; null if rejected
       status: "filled" | "rejected";
       rejectReason: string | null;// SYMBOL_NOT_TRADEABLE | STALE_PRICE |
     }>;                           //   INSUFFICIENT_FUNDS | INSUFFICIENT_POSITION
     finalCash: number;            // cents
     finalPositions: Array<{ symbol: string; quantity: number; avgCost: number }>;
     finalEquity: number | null;   // finalCash + Σ qty × last close (cents)
     totalReturnPct: number | null;// vs startingCash
     equityCurve: Array<{ ts: string; equity: number }>;
   }
   ```
   **Fill-price resolution (D5):** for each order, fill at the most recent
   `price_bar.close` with `ts <= order.at`.
   - No bar at/before `at` → reject `SYMBOL_NOT_TRADEABLE`.
   - Nearest prior bar older than a staleness window (mirror the live engine's
     5 calendar days) → reject `STALE_PRICE`. **Pick and document** the window.
   - Process orders in `at` order; buys need running cash
     (`INSUFFICIENT_FUNDS`), sells need running quantity
     (`INSUFFICIENT_POSITION`); no shorting.
   - Reuse `trading/money.ts` + the lifted validation predicates. Do **not**
     call `latestPrice()` (it returns the latest close, breaking point-in-time
     semantics).
6. **Simplify the cron + best-available precedence.** Keep the startup
   backfill and the `0 30 21 * * 1-5` daily-price firing; remove the snapshot
   chain (`scheduler.ts`). Runs in the `worker` role. Where bars are written
   (`insertBars.ts` / daily-price upsert), make the source-precedence rule
   explicit (D4): when Massive and Finnhub both produce a bar for the same
   (symbol, day), define which wins (recommendation: Finnhub for the
   current/most-recent day, Massive for historical depth) and `ON CONFLICT`
   accordingly. After a successful run, publish the WS updates (step 4).
7. **Migration.** One new `apps/api/migrations/*.sql` that `DROP`s the removed
   tables (§A) in FK-safe order. Leave `app_user`, `identity`,
   `universe_symbol`, `price_bar` untouched.
8. **Contracts.** In `@tickr/shared-types` / `openapi.yaml`: remove the
   game types (portfolio/order/fill/leaderboard); add `UniverseResponse`,
   `PricesResponse`, `EvaluateRequest`/`EvaluateResponse`; rewrite `ws.ts`
   topics to the step-4 shapes; trim `MeResponse` (`portfolioId` gone).

## Definition of done

Gates the full platform backend + the live spine. **Display/rendering is the
only thing explicitly out** (item 18 / item 11).

**Spine — auth + CSRF + sessions + WS + console:**

- [x] **Auth + sessions** — SSO login (Google + GitHub) establishes a session
      cookie; `/me` returns the user + linked identities (no `portfolioId`).
- [x] **CSRF** — the session issues a rotating `csrfToken`; state-changing
      requests require a valid `X-CSRF-Token`.
- [x] **WS connection** — an authenticated client connects to `/ws`,
      subscribes to `universe` / `prices`, and the cron's
      `universe.updated` / `prices.updated` events reach it.
- [x] **Log to console** — the reference client logs each received
      `WsServerMessage` to the console; no UI is built in this item.

**Endpoints + cron:**

- [x] **`GET /universe`** returns the corpus with `backfilled` and bar-coverage
      bounds (`firstBarAt` / `lastBarAt`); `?backfilled=true` filters.
- [x] **`GET /prices`** returns bars within the resolved window for the
      requested corpus; unknown symbols land in `missing` (not a 400); the
      documented size/window caps are enforced.
- [x] **`POST /evaluate`** fills each order at the **point-in-time** close
      (not the latest), computes `totalReturnPct` correctly for a known
      buy/sell pair, emits every reject code
      (`SYMBOL_NOT_TRADEABLE`/`STALE_PRICE`/`INSUFFICIENT_FUNDS`/
      `INSUFFICIENT_POSITION`), and writes nothing to the DB.
- [x] **Cron** still ingests EOD bars for the corpus (no snapshot job runs),
      applies the best-available source-precedence rule on conflict, and
      publishes the WS updates after a successful run.
- [x] **Schema** — `portfolio`, `position`, `trade_order`, `fill`,
      `valuation_snapshot`, `leaderboard_row`, `algo` are dropped;
      `app_user`, `identity`, `universe_symbol`, `price_bar` intact.
- [x] **Contracts/OpenAPI** reflect only the platform endpoints + the
      refocused WS topics; game types removed.

## Files

- Remove: see §A.
- Edit: `apps/api/src/roles/api.ts`, `roles/worker.ts`, `index.ts`,
  `jobs/scheduler.ts`, `jobs/insertBars.ts`, `routes/me.ts`,
  `apps/api/src/ws/*`, `events/publisher.ts`,
  `packages/shared-types/src/*`.
- Create: `apps/api/src/routes/universe.ts`, `routes/prices.ts`,
  `routes/evaluate.ts`, `apps/api/src/eval/replay.ts` (stateless engine),
  `apps/api/scripts/ws-client.ts` (console-logging reference client),
  `apps/api/migrations/*_platformize_drop_game_tables.sql`,
  `apps/api/test/{universe,prices,evaluate,ws}/*.test.ts`.
