# tickr — Design Overview

> **Status:** Draft / for review. These are design documents intended to be
> implemented later. Interfaces and schemas are *defined* here, not implemented.
> Items marked **TODO** require a decision before or during implementation.

## What tickr is

tickr is a public, multiplayer **stock trading game**. Players manage a virtual
portfolio over a fixed-length **season**, competing on a leaderboard. Every player
starts a season with the same virtual capital (**$1,000,000**) and trades a
constrained universe of symbols defined by the season's **theme** (e.g. *Top 50*,
*Big 7*, *Energy*).

Trades are executed against **paper-trading** market data sourced from the
[Alpaca API](https://alpaca.markets/). No real money is ever involved.

**Price ingestion scope is always the full S&P 500 (~500 symbols).** All
historical and live OHLCV data is stored in TimescaleDB and all in-game pricing
(fills, valuations, leaderboard) is served from it.

The **theme** mechanic constrains *what a player can trade* within a season —
e.g., a "Big 7" season limits players to Apple, Microsoft, etc. Theme symbols
must be a subset of the S&P 500. Themes are a gameplay mechanic; they no longer
bound data-ingestion scope (the worker always prices all 500 symbols regardless
of which themes are active).

Players can compete using **traditional** (manual) strategies or **algorithmic**
strategies (user-authored bots that place orders programmatically). The admin
seeds each season's leaderboard with **house bots** (e.g. "lava lamp" / random,
"mixed", etc.) so a season feels populated from day one and gives humans a
baseline to beat.

## Goals

- Fair, fun, low-stakes competition around real market data.
- Predictable, bounded external API usage (Alpaca rate limits respected).
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
  See [09-open-questions](09-open-questions.md#timeseries--backtesting).

## Headline product rules

| Rule | Value | Notes |
|---|---|---|
| Starting capital | $1,000,000 virtual | Identical for every player every season |
| Symbol universe | S&P 500 (~500 symbols) | Upper bound on what can ever be traded; tracked in `universe_symbol` |
| Watch list | Symbols in active season themes | What the worker actively polls; triggers 5-year backfill on first entry |
| Tradeable universe | Season theme (S&P 500 subset) | Gameplay mechanic; symbol tradeable only after backfill completes |
| Season length | 1 month default (per-season field) | See [04-game-mechanics](04-game-mechanics.md) |
| Leaderboard metric | Total equity (cash + positions) | Ranked desc; ties → see mechanics |
| Auth | Google + GitHub SSO (OAuth 2.0 / OIDC) | No local passwords |
| Bots | Admin-seeded + user-authored | House bots populate leaderboard |

## Technology summary

- **Frontend:** React + **TypeScript** (TypeScript is the default everywhere on
  the client). See [06-frontend](06-frontend.md).
- **Backend:** TypeScript (Node.js) by default. A compiled language (**Go**, or
  another) is an explicitly reserved escape hatch for hot paths if profiling
  shows we need it. See [01-architecture](01-architecture.md#language-strategy).
- **Data:** PostgreSQL + **TimescaleDB extension** (system of record + OHLCV price-bar history; all in-game pricing served from here) + Redis (job queue, rate-limit counters, session helpers, leaderboard read cache).
- **Market data:** Alpaca API (paper/market-data endpoints).
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
| [08-deployment.md](08-deployment.md) | VPS topology, Alpaca integration, ops |
| [09-open-questions.md](09-open-questions.md) | Consolidated TODOs / decisions needed |

## Glossary

- **Season** — A time-boxed competition with one theme and one leaderboard.
- **Theme** — The constrained symbol universe for a season (e.g. *Big 7*).
- **Portfolio** — A player's holdings + cash within a single season.
- **Position** — A held quantity of one symbol within a portfolio.
- **Order** — An instruction to buy/sell; when accepted it produces a fill.
- **Valuation snapshot** — A periodic mark-to-market of every portfolio, used for
  the leaderboard. The source of truth for ranking, *not* live quotes.
- **Bot / algo** — A non-interactive strategy that places orders programmatically.
  *House bots* are admin-owned; *user algos* are player-owned.
