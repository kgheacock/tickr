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
| 01 | [Dev environment](01-dev-environment.md) | — | implemented |
| 02 | [Shared contracts](02-shared-contracts.md) | 01 | done |
| 03 | [Database schema](03-database-schema.md) | 01 | done |
| 04 | [Auth (SSO + sessions)](04-auth.md) | 02, 03 | [done](https://github.com/kgheacock/tickr/pull/7) |
| 05 | [Finnhub client](05-finnhub-client.md) | 01 | [done](https://github.com/kgheacock/tickr/pull/8) |
| 06 | [Backfill + daily price](06-backfill-and-daily-price.md) | 03, 05, 13, 14 | [done](https://github.com/kgheacock/tickr/pull/9) |
| 07 | [Trading engine](07-trading-engine.md) | 03, 04, 06 | pending |
| 08 | [Snapshots + leaderboard](08-snapshots-and-leaderboard.md) | 06, 07 | pending |
| 09 | [WebSocket gateway](09-websocket-gateway.md) | 04, 07, 08 | pending |
| 10 | [Observability + admin](10-observability-and-admin.md) | 04, 06, 08 | pending |
| 11 | [Frontend SPA](11-frontend.md) | 02, 04, 07, 08, 09 | pending |
| 12 | [Deployment](12-deployment.md) | 01, 03, 10, 11 | pending |
| 13 | [Massive client](13-massive-client.md) | 01 | [done](https://github.com/kgheacock/tickr/pull/9) |
| 14 | [Kaggle client](14-kaggle-client.md) | 03, 13 | [done](https://github.com/kgheacock/tickr/pull/9) |
| 15 | [Migrate to pnpm](15-migrate-to-pnpm.md) | — | [done](https://github.com/kgheacock/tickr/pull/13) |

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

## What's *not* in v1

These belong to later phases — track separately when v2/v3 starts:

- Seasons (`season` table, lifecycle, transitions)
- Themes (`theme`, `theme_symbol`, watch list view)
- The 6-strategy bot registry beyond `index`
- User-authored algos
- Finnhub WebSocket integration (v2)
- Per-snapshot (5-min) cadence
- Prometheus/Grafana metrics stack
