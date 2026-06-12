# tickr — v1 implementation plan

This directory tracks the **v1 implementation work** — the perpetual
leaderboard described in [docs/00-overview.md](../docs/00-overview.md). Each
file is a focused playbook for one slice of v1. v2 (seasons + themes + bot
registry) and v3 (user algos) are out of scope here.

## How to use

- Pick an item with no unmet **Depends on**.
- Read its **Pre-reads** first — the design decisions live in `docs/`, not
  here. These plans are *how to build it*, not *what to build*.
- Work through **Steps** in order; check off **Definition of done** before
  marking the item complete.
- If you discover a design gap mid-implementation, add it to
  [docs/09-open-questions.md](../docs/09-open-questions.md) — don't decide
  in the TODO.

Status legend: `pending` / `in-progress` / `done`. Mark inline at the top
of each file as you go.

## Items

| # | Item | Depends on | Status |
|---|---|---|---|
| 01 | [Dev environment](01-dev-environment.md) | — | [done](https://github.com/kgheacock/tickr/pull/3) |
| 02 | [Shared contracts](02-shared-contracts.md) | 01 | [done](https://github.com/kgheacock/tickr/pull/4) |
| 03 | [Database schema](03-database-schema.md) | 01 | [done](https://github.com/kgheacock/tickr/pull/6) |
| 04 | [Auth (SSO + sessions)](04-auth.md) | 02, 03 | [done](https://github.com/kgheacock/tickr/pull/7) |
| 05 | [Finnhub client](05-finnhub-client.md) | 01 | [done](https://github.com/kgheacock/tickr/pull/8) |
| 06 | [Backfill + daily price](06-backfill-and-daily-price.md) | 03, 05, 13 | [done](https://github.com/kgheacock/tickr/pull/9) |
| 07 | [Trading engine](07-trading-engine.md) | 03, 04, 06 | [done](https://github.com/kgheacock/tickr/pull/12) |
| 08 | ~~Snapshots + leaderboard~~ (superseded by item 16) | 06, 07 | [removed](https://github.com/kgheacock/tickr/pull/25) |
| 09 | [WebSocket gateway](09-websocket-gateway.md) | 04, 07, 08 | [done](https://github.com/kgheacock/tickr/pull/21) |
| 10 | [Observability + admin](10-observability-and-admin.md) | 04, 16 | [done](https://github.com/kgheacock/tickr/pull/36) |
| 11 | [Frontend SPA](11-frontend.md) | 16 | [done](https://github.com/kgheacock/tickr/pull/27) |
| 12 | [Deployment](12-deployment.md) | 01, 03, 10, 11, 19 | [in review](https://github.com/kgheacock/tickr/pull/39) |
| 13 | [Massive client](13-massive-client.md) | 01 | [done](https://github.com/kgheacock/tickr/pull/9) |
| 14 | ~~Kaggle client~~ (removed — see docs/11-data-audit-findings.md) | — | [removed](https://github.com/kgheacock/tickr/pull/29) |
| 15 | [Migrate to pnpm](15-migrate-to-pnpm.md) | — | [done](https://github.com/kgheacock/tickr/pull/13) |
| 16 | [Platformize the API](16-platformize-api.md) | 03, 04, 06, 09 | [done](https://github.com/kgheacock/tickr/pull/25) |
| 17 | [ETF over a weighted corpus](17-etf-weighted-corpus.md) | 16 | [done](https://github.com/kgheacock/tickr/pull/31) |
| 18 | [Display: ETF editor, strategy & plot](18-display-logic.md) | 16, 17 | [done](https://github.com/kgheacock/tickr/pull/33) |
| 19 | [Data audit](19-data-audit.md) | 06, 13 | [done](https://github.com/kgheacock/tickr/pull/28) |
| 21 | [Logout fix + dev auth](21-logout-fix-and-dev-auth.md) | 04, 11, 12 | [in review](https://github.com/kgheacock/tickr/pull/44) |
| 22 | [Ticker metadata + branding](22-ticker-metadata-and-branding.md) | 13, 19 | [in review](https://github.com/kgheacock/tickr/pull/56) |
| 23 | [Admin logs: deploy commit + backfill status](23-admin-logs-meta-and-status.md) | 10, 21 | [done](https://github.com/kgheacock/tickr/pull/57) |
| 24 | [Landing: logo board → markets ribbon](24-landing-flap-board-logos.md) | 11, 22 | [in review](https://github.com/kgheacock/tickr/pull/62) |
| 25 | [Universe source: CSV → live Wikipedia constituents](25-universe-from-wikipedia.md) | 03, 13 | [in review](https://github.com/kgheacock/tickr/pull/64) |
| 26 | [Schedule data jobs in the worker cron](26-schedule-data-jobs-cron.md) | 22, 25 | [in review](https://github.com/kgheacock/tickr/pull/69) |
| 27 | [Symbol metadata JSON endpoint](27-symbol-metadata-endpoint.md) | 22 | [in review](https://github.com/kgheacock/tickr/pull/67) |

> **Pivot (items 16–18):** the project is being re-scoped from a trading
> *game* to a market-data + returns *platform*. Item 16 keeps the data corpus
> core (`universe_symbol`, `price_bar`, the ingestion cron) **plus auth/SSO +
> sessions + CSRF and a refocused WebSocket** that pushes live updates for the
> platform endpoints; its DoD stops at the spine (auth + CSRF + sessions + WS
> connection logging to console — **no display logic**). It removes the
> game-only surface (portfolios, trading, snapshots, leaderboard, bots) with
> prejudice and **supersedes items 07, 08** and the game parts of 09/11.
> Item 17 adds ETFs as synthetic weighted baskets over the corpus. Item 18
> builds the display layer on top: seed the S&P 500 as an ETF, let the user
> fork/edit it, run a built-in SMA-crossover strategy through `/evaluate`, and
> plot the performance. Items 11 and 18 both depend on 16.

## Dependency graph (at a glance)

```
01 dev-environment ─┬─▶ 02 shared-contracts ─┐
                    ├─▶ 03 schema ──────────┐│
                    ├─▶ 05 finnhub-client ─┐││
                    └─▶ 13 massive-client   │││
                                            │││
03 ──▶ 06 backfill+daily ◀──────────────────┘│
       06 ──▶ 07 trading-engine ◀── 04 auth ◀┘
                    │
                    └─▶ 08 snapshots+leaderboard
                                │
                                └─▶ 09 ws gateway
                                └─▶ 10 obs+admin

02, 04, 07, 08, 09 ──▶ 11 frontend
01, 03, 10, 11    ──▶ 12 deployment
```

## Slicing rationale

Each file is sized for **one focused pull request** by one engineer in
roughly a day or two. Boundaries follow the architecture in
[docs/01-architecture.md](../docs/01-architecture.md) — auth, ingestion,
trading, snapshots, realtime, frontend, deploy each live in their own item.
Cross-cutting concerns (logging, metrics, rate limiting) bundle into
item 10 so they aren't sprinkled half-implemented across other items.

## Epics (v2+)

Larger multi-item tracks live in their own folder with a self-contained index,
so this root list stays a focused v1 plan. One line per epic:

- [Fantasy Street](fantasy-street/README.md) — seasonal head-to-head stock
  league (the "Seasons" concept). 12 items, `pending`.

## What's *not* in v1

These belong to later phases — track separately when v2/v3 starts:

- Seasons (`season` table, lifecycle, transitions) — see
  [Epics → Fantasy Street](fantasy-street/README.md)
- Themes (`theme`, `theme_symbol`, watch list view)
- The 6-strategy bot registry beyond `index`
- User-authored algos
- Finnhub WebSocket integration (v2)
- Per-snapshot (5-min) cadence
- Prometheus/Grafana metrics stack
