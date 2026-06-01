# tickr — Design Overview

> **Status:** Draft / for review. These are design documents intended to be
> implemented later. Interfaces and schemas are *defined* here, not implemented.
> Items marked **TODO** require a decision before or during implementation.

## What tickr is

tickr is a public **stock trading game**. Players manage a virtual portfolio of
real S&P 500 names, competing on a leaderboard. Every player starts with the
same virtual capital (**$1,000,000**). Market data — real-time quotes and
historical OHLCV bars — comes from external REST APIs (Massive for bootstrap
backfill; Finnhub for daily price updates) and is stored permanently in
TimescaleDB, which is the sole source of pricing for
fills, valuations, and the leaderboard. No real money is ever involved.

## Phases

tickr ships in three phases, each layering onto the previous. Code, schema, and
contracts are designed so each phase is additive — no rewrites between phases.

| Phase | Scope | Game loop |
|---|---|---|
| **v1** | Perpetual leaderboard | Sign in → one portfolio per user → $1M cash → trade any S&P 500 symbol 24/7 (market orders, fill at last close) → daily EOD snapshot updates ranking |
| **v2** | Seasons + themes + bot registry | Time-boxed competitions on a constrained symbol universe ("Big 7", "Energy"); admin seeds each season with a registry of house bots |
| **v3** | User-authored algos | Players register algorithmic strategies (declarative; sandboxed user code deferred) and attach them to seasons |

Each phase is shippable on its own. v1 is intentionally small so the system can
run end-to-end on a single VPS with the smallest possible surface area.

### v1 scope

- **One perpetual leaderboard.** No seasons; no end date. Every player has one
  portfolio that persists.
- **Full S&P 500 tradeable.** No themes; no constrained universe. The
  `universe_symbol` table is the only gate (a symbol must be backfilled before
  it accepts orders).
- **Market orders only**, immediate fill at the most recent
  `price_bar.close` from TimescaleDB.
- **Daily EOD snapshots**: once per day after the US market close, mark every
  portfolio to market and refresh the leaderboard. The ranking moves once a day.
- **One built-in house bot** ("index") that holds an equally-weighted basket of
  the S&P 500 from day one. Gives players a baseline to beat.
- **No user-authored algos** (deferred to v3).

### v2 outlook — seasons, themes, bot registry

v2 wraps the v1 portfolio + leaderboard in **seasons** (start/end,
`draft → scheduled → active → settling → closed`) and constrains each season
to a **theme** (Big 7, Top 50, Energy, …). The watch list narrows from "the
S&P 500" to "the union of active seasons' themes," cutting market data load and
making each season feel distinct. The single v1 bot expands into the
**registry** described in [07-bots-and-algos](07-bots-and-algos.md): `random`,
`buy_and_hold`, `mixed`, `momentum`, `mean_reversion`, `cash_drip`. Admin
seeds each season's leaderboard at creation.

### v3 outlook — user algos

v3 lets players register their own algorithmic strategies (one of the
registered v2 strategy types, parameterized) and attach them to a season as a
portfolio driver. Per-user cap (e.g. 3 algos per season) bounds bot-runner
load. Running arbitrary user code is **deferred indefinitely**; if pursued
later it must be sandboxed (WASM/isolate) or webhook-based. See
[07-bots-and-algos](07-bots-and-algos.md).

## Goals

- Fair, fun, low-stakes competition around real market data.
- Predictable, bounded external API usage proportional to actual play.
- Ship v1 small enough to run on a single VPS with one image and one database.
- Phase boundaries that are **additive**, not rewrites.
- Clear, typed contracts between frontend and backend from day one.

## Non-goals (initially)

- Real-money trading or anything requiring brokerage/financial regulation.
- Real-time tick-by-tick execution (v1 is EOD; v2 is per-snapshot).
- Horizontal multi-node scaling. Single VPS is the target; the design should
  *not preclude* scaling later, but we will not build for it up front.
- A mobile native app. The web frontend is responsive; native is out of scope.
- A backtesting sandbox (future). The timeseries layer is provisioned from
  day one so replay infrastructure has a foundation when the feature is built.
  See [09-open-questions](09-open-questions.md).

## Headline rules

| Rule | v1 | v2+ |
|---|---|---|
| Starting capital | $1,000,000 virtual | same |
| Tradeable universe | Full S&P 500 (~500 symbols) | Constrained per season's theme |
| Tradeable gate | `universe_symbol.backfilled = true` | same |
| Game window | Perpetual (no end) | Season-bounded (default 30 days) |
| Snapshot cadence | Daily EOD | `season.snapshotIntervalSec` (default 300 s) |
| Leaderboard metric | Total equity (cash + positions) | same |
| Bots | One built-in `index` bot | Registry of 6 strategy types, admin-seeded per season |
| User algos | — | v3: registered strategy types, capped per user/season |
| Auth | Google + GitHub SSO | same |

## Technology summary

- **Frontend:** React + **TypeScript**. See [06-frontend](06-frontend.md).
- **Backend:** TypeScript (Node.js) by default; Go is a reserved escape hatch
  for hot paths if profiling shows a need. See
  [01-architecture](01-architecture.md#3-language-strategy).
- **Data:** PostgreSQL + **TimescaleDB extension** (system of record + OHLCV
  `price_bar` hypertable; all in-game pricing served from here) + Redis (job
  queue, rate-limit counters, session helpers, leaderboard read cache).
- **Market data:** two REST providers in v1 — Massive Custom Bars endpoint
  for bootstrap backfill (2 years of daily OHLCV bars); Finnhub `GET /quote`
  for daily price updates. WebSocket streaming enters in v2 when intraday
  pricing becomes relevant.
- **Hosting:** Single VPS (Hetzner), containerized via Docker Compose. See
  [08-deployment](08-deployment.md).

## Document map

| Doc | Phase scope | Purpose |
|---|---|---|
| [00-overview.md](00-overview.md) | All phases | This doc — phased framing |
| [01-architecture.md](01-architecture.md) | v1 body + v2+ outlook | Components, data flow, language strategy |
| [02-data-model.md](02-data-model.md) | v1 body + v2+ outlook | Entities, schema, invariants |
| [03-api.md](03-api.md) | v1 body + v2+ outlook | REST/WS surface, request/response types |
| [04-game-mechanics.md](04-game-mechanics.md) | v1 body + v2+ outlook | Rules of play |
| [05-auth.md](05-auth.md) | All phases | Google + GitHub SSO, sessions, roles |
| [06-frontend.md](06-frontend.md) | v2+ design | React/TS app structure; some routes are v2+ |
| [07-bots-and-algos.md](07-bots-and-algos.md) | v2+ (registry) / v3+ (user algos) | The bot registry and algo execution model |
| [08-deployment.md](08-deployment.md) | v1 body (§2, §5, §6) + general | VPS topology, market data, jobs, ops |
| [09-open-questions.md](09-open-questions.md) | All phases | Decisions record + open items |

## Glossary

- **Portfolio** — A player's holdings + cash. In v1, one per user, perpetual.
  In v2+, one per (user, season).
- **Position** — A held quantity of one symbol within a portfolio.
- **Order** — An instruction to buy/sell; when accepted it produces a fill.
- **Fill** — Execution of an order at the latest `price_bar.close` from
  TimescaleDB.
- **Valuation snapshot** — A periodic mark-to-market of every portfolio.
  Source of truth for ranking. Cadence: daily (v1) / per-snapshot (v2+).
- **Leaderboard** — Ranking of portfolios by latest-snapshot equity.
  Perpetual in v1; per-season in v2+.
- **Universe** — The full S&P 500 symbol registry (`universe_symbol` table).
  The upper bound on what can ever be tradeable.
- **Backfill** — The one-time load of 2 years of daily OHLCV bars for a
  symbol (via Massive). In v1, bootstrap-loaded for all 500 symbols at
  install. In v2+, triggered when a symbol first enters a theme's watch list.
- **Watch list** — *(v2+)* The union of symbols across all active seasons'
  themes. In v1 the watch list is implicit (the held set + the bot's basket).
- **Theme** — *(v2+)* The constrained symbol universe for a season.
- **Season** — *(v2+)* A time-boxed competition with one theme and one
  leaderboard.
- **Bot / algo** — A non-interactive strategy that places orders
  programmatically. v1 ships one built-in `index` bot; v2 adds a registry of
  house bots; v3 adds user-authored algos.
