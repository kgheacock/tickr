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
| O1 | Alpaca tier + rate limits + data freshness | **Algo Trader ($9/mo)** — real-time WebSocket bars; verify exact limits at implementation time |
| O2 | Job-queue durability | **Re-enqueue on boot** using idempotency keys; no Redis persistence mode needed |
| O3 | Backup cadence/retention + restore drill | **Daily `pg_dump` to off-VPS storage; 7-day retention; restore drill before each new season** (`pg_dump` includes TimescaleDB hypertable data) |

## Timeseries & data architecture ([01](01-architecture.md), [02](02-data-model.md))

| # | Question | Decision | Rationale |
|---|---|---|---|
| T1 | Timeseries DB choice | **TimescaleDB** (Postgres extension) | No new service on the VPS — same container, same `DATABASE_URL`, same `pg_dump` backup path. Hypertables + columnar compression handle OHLCV append workloads well. Alternatives considered: QuestDB (fast but another process + port, different query language), InfluxDB (separate service, Flux/InfluxQL instead of SQL), ClickHouse (excellent for analytics but heavy for a single-VPS game). TimescaleDB wins on operational simplicity for the single-VPS target. |
| T2 | Price data ingestion scope | **Full S&P 500 (~500 symbols), always** | Fixed universe simplifies ops (no per-season symbol-set logic in the worker), provides coverage for any theme subset, and gives backtesting a complete dataset. The worker polls all components every cycle regardless of active themes. |
| T3 | Theme purpose redefined | **Themes are a gameplay mechanic only** — they constrain what a player may trade in a season; they no longer bound data ingestion | Previous rationale ("bound Alpaca load") no longer applies when we poll all 500 symbols. Theme symbols must be S&P 500 members (`universe_symbol` FK). |
| T4 | Source of truth for all in-game pricing | **TimescaleDB `price_bar`** — fills, valuation snapshots, and bot strategy context all read from here | Single source eliminates Redis-vs-Postgres divergence. Redis retains queue, rate-limit, session, and leaderboard-cache roles; it is no longer used for quote data. |
| T5 | Backfill strategy | **`universe_symbol`-driven cron: 5 years of 5-min bars per symbol, loaded on insert** | Matches live cadence (G4), giving backtests full parity with live game resolution. ~125 M rows total (500 × 5y × ~252 days × 78 bars/day); TimescaleDB compression keeps this manageable. |
| T6 | No-trade-until-backfill gate | **Symbol not tradeable until `universe_symbol.backfilled = true`** | Prevents orders from filling against a symbol with incomplete price history, which would break snapshot and backtest reproducibility. |
| T7 | `universe_symbol` population | **Admin-managed (manual upsert)** in v1; periodic check job deferred | Keeps v1 simple. S&P 500 composition changes infrequently (~30–50 changes/year); admin can act on rebalance announcements without an automated feed. |

| # | Open question | Notes |
|---|---|---|
| T2b | Does Alpaca Algo Trader provide 5 years of 5-min bar history for ~500 symbols within its rate limits? | Verify at implementation time. If the tier falls short (depth or rate), alternatives: bulk-import from Polygon.io, Yahoo Finance, or a public OHLCV corpus (e.g. Kaggle S&P 500 datasets). The `price_bar` schema is source-agnostic — ingestion path changes, consumers do not. |
