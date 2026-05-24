# 09 — Decisions Record

Previously the consolidated TODO list; now a record of decisions made and their
rationale. Each item links back to its source doc where the decision is applied.

## Game mechanics ([04](04-game-mechanics.md))

| # | Question | Decision | Rationale |
|---|---|---|---|
| G1 | Season length | **1 month default**; stored per-season in `endsAt` | Balances skill vs. luck; per-season field lets future seasons experiment |
| G2 | Trading window | **24/7; fill at latest `price_bar.close` from TimescaleDB** | Simplest UX; fairness preserved (shared bar price in each snapshot window) |
| G3 | Fees / commissions | **Zero in v1**; `season.commissionCents` reserved | Legible results; can add to curb churn without re-architecting |
| G4 | Snapshot cadence | **5 min / 300 s** (`snapshotIntervalSec` default) | Frequent enough to feel live; within Alpaca Algo Trader rate budget |
| G5 | Leaderboard tie-breaking | **Shared rank; stable secondary sort by `portfolioId`** | Deterministic and simple; revisit with risk-adjusted metric later |
| G6 | Late-join policy for `active` seasons | **Allow until 25% of duration elapsed** | Balances engagement vs. fairness |
| G7 | Shorting / margin / limit orders | **Out of scope v1** (schema reserves room) | Keeps invariants simple; `CHECK (quantity >= 0)` enforces no shorts |

## Data model ([02](02-data-model.md))

| # | Question | Decision |
|---|---|---|
| D1 | Multiple portfolios per user per season | **1 manual + up to 3 algo portfolios** per user per season |
| D2 | Fractional-share precision | **`NUMERIC(20,8)`** confirmed — 8 decimal places is more than sufficient |
| D3 | Contract source-of-truth across a polyglot future | **OpenAPI + JSON** for public API; **shared TS package** (`@tickr/shared-types`) for internal boundaries |

## API ([03](03-api.md))

| # | Question | Decision |
|---|---|---|
| A1 | Concrete rate-limit numbers | Define per-endpoint at implementation time; stricter on order/algo routes; token-bucket counters in Redis |
| A2 | Contract format | Same as D3 (OpenAPI/JSON public; shared TS internal) |

## Auth ([05](05-auth.md))

| # | Question | Decision |
|---|---|---|
| AU1 | Duplicate-signup / account-merge policy | **Auto-link if verified emails match**; else create distinct account (admin merges on request) |
| AU2 | Absolute session lifetime + refresh | **Sliding expiry; 30-day absolute maximum** |
| AU3 | Admin bootstrap mechanism | **Env allowlist of provider subjects** (`ADMIN_BOOTSTRAP`) |

## Frontend ([06](06-frontend.md))

| # | Question | Decision |
|---|---|---|
| F1 | Styling approach | **CSS Modules** — scoped, no runtime, matches workspace convention |
| F2 | Charting library | **Lightweight Charts** (TradingView) — purpose-built for financial time-series |
| F3 | Component library vs. hand-roll | **Hand-roll early**; reach for Semantic UI React only if a library becomes necessary |

## Bots & algos ([07](07-bots-and-algos.md))

| # | Question | Decision |
|---|---|---|
| B1 | Allow arbitrary user code? If so, sandbox tech | **Deferred**; if pursued: sandboxed WASM/isolate or inbound webhook |
| B2 | Intent rejection location (runner vs order API) | **Order API** — single source of truth for validation |
| B3 | Default risk caps for house bots | **Max order 10% of equity; max position 25% of equity** |
| B4 | Cap on user algos per user/season | **3 algos per user per season** (house bots exempt) |

## Backend language ([01](01-architecture.md#language-strategy))

| # | Question | Decision |
|---|---|---|
| L1 | When to rewrite a hot path in Go | **Only after profiling shows need** — likely snapshot loop or bot runner first |
| L2 | Keep 3 backend roles as one image or split | **One image, `ROLE` env var** initially; split only if independent deploy cadences require it |

## Deployment / Alpaca ([08](08-deployment.md))

| # | Question | Decision |
|---|---|---|
| O1 | Market data provider + tier | **Finnhub** — switched from Alpaca. Free tier ($0/mo) provides real-time US quotes + WebSocket streaming for ≤50 symbols + 60 req/min REST. Paid tiers from ~$11.99/mo add unlimited WebSocket symbols and higher REST quota. Free tier viable for themes ≤50 symbols. |
| O2 | Job-queue durability | **Re-enqueue on boot** using idempotency keys; no Redis persistence mode needed |
| O3 | Backup cadence/retention + restore drill | **Daily `pg_dump` to off-VPS storage; 7-day retention; restore drill before each new season** (`pg_dump` includes TimescaleDB hypertable data) |

## Timeseries & data architecture ([01](01-architecture.md), [02](02-data-model.md))

| # | Question | Decision | Rationale |
|---|---|---|---|
| T1 | Timeseries DB choice | **TimescaleDB** (Postgres extension) | No new service on the VPS — same container, same `DATABASE_URL`, same `pg_dump` backup path. Hypertables + columnar compression handle OHLCV append workloads well. Alternatives considered: QuestDB (fast but another process + port, different query language), InfluxDB (separate service, Flux/InfluxQL instead of SQL), ClickHouse (excellent for analytics but heavy for a single-VPS game). TimescaleDB wins on operational simplicity for the single-VPS target. |
| T2 | Live polling scope | **Watch list only** — the union of symbols across all active seasons' themes, recomputed each poll cycle | S&P 500 is the upper bound on what can ever be in the watch list, not the polling scope. Load stays proportional to game activity. Original "poll all 500" design was incorrect. |
| T3 | Theme purpose | **Themes are a gameplay mechanic** — they constrain what a player may trade and define the watch list for their season | Themes also serve as a soft data-cost lever: fewer theme symbols = smaller watch list = fewer WebSocket subscriptions and REST calls. |
| T4 | Source of truth for all in-game pricing | **TimescaleDB `price_bar`** — fills, valuation snapshots, and bot strategy context all read from here | Single source eliminates Redis-vs-Postgres divergence. Redis retains queue, rate-limit, session, and leaderboard-cache roles; it is no longer used for quote data. |
| T5 | Backfill strategy | **Watch-list-driven cron: 5 years of 5-min bars per symbol via `GET /stock/candle`, triggered on season activation** | Triggers when a symbol first appears in the watch list with `backfilled = false`. ~49 M rows total for full 500-symbol corpus. Per-symbol call count depends on Finnhub's response window size (see T2b). REST rate limit: 60 req/min (free tier). Matches live cadence (G4). |
| T6 | No-trade-until-backfill gate | **Symbol not tradeable until `universe_symbol.backfilled = true`** | Prevents orders from filling against a symbol with incomplete price history, which would break snapshot and backtest reproducibility. |
| T7 | `universe_symbol` population | **Admin-managed (manual upsert)** in v1; periodic check job deferred | Keeps v1 simple. S&P 500 composition changes infrequently (~30–50 changes/year); admin can act on rebalance announcements without an automated feed. |
| T2b | Finnhub historical bar depth and per-call response window | **Open** (data provider changed from Alpaca to Finnhub). Need to verify: (1) how many years of 5-min OHLCV history `GET /stock/candle?resolution=5` returns per call; (2) whether it paginates or returns all bars in one call per time range; (3) free-tier restrictions on historical depth. Prior Alpaca finding (SIP bars since 2016, confirmed) is no longer applicable. |

## Finnhub integration ([08](08-deployment.md))

| # | Open question | Notes |
|---|---|---|
| F1 | Commercial licensing — does Finnhub's free tier permit a public game? | Free tier ToS must be reviewed before launch. "Commercial use" may require a paid plan regardless of symbol count or call volume. Verify with Finnhub support or legal terms. |
| F2 | WebSocket symbol limit per plan — at what watch-list size must we upgrade from free? | Free tier: 50 simultaneous symbols. If any season theme exceeds 50 symbols, the worker must subscribe to overflow symbols via REST polling. Confirm the paid plan cost and symbol limit at the next tier. |
| F3 | REST rate limit under combined load — does the 60 req/min bucket cover both REST fallback poll and backfill cron simultaneously? | At 60 req/min, a 50-symbol REST fallback poll uses 50 calls/interval; backfill of a 50-symbol theme uses ~50–N calls (depends on T2b window size). Worst case: both running simultaneously at season start could saturate the free-tier bucket. Backfill should run at reduced rate or be scheduled off-peak. |
