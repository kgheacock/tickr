# tickr — Design Overview

> **Status:** Draft / for review. These are design documents intended to be
> implemented later. Interfaces and schemas are *defined* here, not implemented.
> Items marked **TODO** require a decision before or during implementation.

## What tickr is

tickr is a public, multiplayer **stock trading game**. Players manage a virtual
portfolio over a fixed-length **season**, competing on a leaderboard. Every player
starts a season with the same virtual capital (**$1,000,000**) and trades a
constrained universe of symbols defined by the season's **theme** (e.g. *Top 50*,
*Big 7*, *Energy*). No real money is ever involved.

All tradeable symbols are drawn from the **S&P 500**. Market data (real-time
quotes and historical OHLCV bars) is sourced from the
[Finnhub API](https://finnhub.io/) and stored permanently in TimescaleDB, which
is the sole source of pricing for fills, valuations, and the leaderboard.

The **theme** mechanic constrains what a player can trade within a season — a
"Big 7" season limits players to a curated set of large-cap names. Themes are a
gameplay mechanic; they also govern which symbols the system actively prices via
the **watch list** (the union of symbols across all active seasons' themes).
When a symbol enters the watch list for the first time it is backfilled with
5 years of 5-minute bar history before it becomes tradeable.

Players can compete using **traditional** (manual) strategies or **algorithmic**
strategies (user-authored bots that place orders programmatically). The admin
seeds each season's leaderboard with **house bots** (e.g. "lava lamp" / random,
"mixed", etc.) so a season feels populated from day one and gives humans a
baseline to beat.

## Goals

- Fair, fun, low-stakes competition around real market data.
- Predictable, bounded external API usage proportional to active game activity.
- Support both human ("traditional") and programmatic ("algorithmic") play.
- Easy to operate as a single-VPS public project.
- Clear, typed contracts between frontend and backend from day one.

## Non-goals (initially)

- Real-money trading or anything requiring brokerage/financial regulation.
- Real-time tick-by-tick execution (we use periodic valuation snapshots).
- Horizontal multi-node scaling. Single VPS is the target; the design should
  *not preclude* scaling later, but we will not build for it up front.
- A mobile native app. The web frontend is responsive; native is out of scope.
- A backtesting sandbox (future). The timeseries data layer is provisioned from
  day one so replay infrastructure has a foundation when the feature is built.
  See [09-open-questions](09-open-questions.md#timeseries--data-architecture).

## Headline product rules

| Rule | Value | Notes |
|---|---|---|
| Starting capital | $1,000,000 virtual | Identical for every player every season |
| Symbol universe | S&P 500 (~500 symbols) | Upper bound on all tradeable symbols; tracked in `universe_symbol` |
| Watch list | Symbols in active season themes | Drives live pricing + backfill; currently the union of active theme symbols |
| Tradeable gate | Symbol must be backfilled | `universe_symbol.backfilled = true` required before orders are accepted |
| Season length | 1 month default (per-season field) | See [04-game-mechanics](04-game-mechanics.md) |
| Leaderboard metric | Total equity (cash + positions) | Ranked desc; ties → see mechanics |
| Auth | Google + GitHub SSO (OAuth 2.0 / OIDC) | No local passwords |
| Bots | Admin-seeded + user-authored | House bots populate leaderboard |

## Technology summary

- **Frontend:** React + **TypeScript**. See [06-frontend](06-frontend.md).
- **Backend:** TypeScript (Node.js) by default; Go is a reserved escape hatch
  for hot paths if profiling shows a need. See
  [01-architecture](01-architecture.md#language-strategy).
- **Data:** PostgreSQL + **TimescaleDB extension** (system of record + OHLCV
  `price_bar` hypertable; all in-game pricing served from here) + Redis (job
  queue, rate-limit counters, session helpers, leaderboard read cache).
- **Market data:** Finnhub API — WebSocket streaming for real-time quotes
  (≤50 symbols free) + REST `/stock/candle` for historical backfill.
- **Hosting:** Single VPS, containerized. See [08-deployment](08-deployment.md).

## Document map

| Doc | Purpose |
|---|---|
| [01-architecture.md](01-architecture.md) | System components, data flow, language strategy |
| [02-data-model.md](02-data-model.md) | Entities, relationships, schema definitions |
| [03-api.md](03-api.md) | REST/WS surface, request/response interface definitions |
| [04-game-mechanics.md](04-game-mechanics.md) | Seasons, themes, capital, scoring, leaderboard |
| [05-auth.md](05-auth.md) | Google + GitHub SSO, sessions, roles |
| [06-frontend.md](06-frontend.md) | React/TS app structure, shared types, views |
| [07-bots-and-algos.md](07-bots-and-algos.md) | House bots + user algorithmic strategies |
| [08-deployment.md](08-deployment.md) | VPS topology, Finnhub integration, ops |
| [09-open-questions.md](09-open-questions.md) | Decisions record + open questions |

## Glossary

- **Season** — A time-boxed competition with one theme and one leaderboard.
- **Theme** — The constrained symbol universe for a season (e.g. *Big 7*). Must
  be a subset of the S&P 500 universe.
- **Watch list** — The union of symbols across all currently active seasons'
  themes. Drives live WebSocket subscriptions and backfill. Designed to expand
  beyond active seasons in future (e.g. pre-season prep, admin overrides).
- **Universe** — The full S&P 500 symbol registry (`universe_symbol` table).
  The upper bound on what can ever appear in a theme or watch list.
- **Backfill** — The one-time load of 5 years of 5-minute OHLCV bars for a
  symbol when it first enters the watch list. Symbol is not tradeable until
  backfill completes.
- **Portfolio** — A player's holdings + cash within a single season.
- **Position** — A held quantity of one symbol within a portfolio.
- **Order** — An instruction to buy/sell; when accepted it produces a fill.
- **Fill** — Execution of an order at the latest `price_bar.close` from
  TimescaleDB.
- **Valuation snapshot** — A periodic mark-to-market of every portfolio, used
  for the leaderboard. The source of truth for ranking, not live quotes.
- **Bot / algo** — A non-interactive strategy that places orders
  programmatically. *House bots* are admin-owned; *user algos* are player-owned.
