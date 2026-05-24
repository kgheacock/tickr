# 08 — Deployment & Operations

> Topology and operational contracts — **not implemented**. Target is a single
> VPS running the public project, with room to extract a component later.

## 1. Topology (single VPS)

```
                 Internet
                    │  443/tls
            ┌───────▼────────┐
            │  Reverse proxy  │  (Caddy or nginx)
            │  TLS, routing,  │
            │  static assets  │
            └───┬────────┬────┘
        /api,/ws│        │ /  (static React build)
          ┌─────▼─────┐  └────────────────► built web assets
          │ API svc   │
          └─────┬─────┘
   shared image │ (role via env)
   ┌────────────┼─────────────┐
   │            │             │
┌──▼───┐   ┌────▼────┐   ┌─────▼─────┐
│Worker│   │Bot runner│   │  (API)    │
└──┬───┘   └────┬────┘   └─────┬─────┘
   └─────┬──────┴──────┬───────┘
     ┌───▼───┐     ┌────▼────┐
     │Postgres│     │  Redis  │
     └────────┘     └─────────┘
            │ outbound only
        ┌───▼────┐
        │ Alpaca │
        └────────┘
```

- **Containerized** with Docker Compose (recommended for a single VPS): proxy,
  api, worker, bot-runner, postgres, redis. API/worker/bot-runner may be the
  **same image** with a role selected by env var initially.
- **TimescaleDB** runs as a Postgres extension inside the same `postgres`
  container (use the `timescale/timescaledb-ha` or `timescale/timescaledb`
  image instead of stock `postgres`). No additional service or port required;
  all existing `DATABASE_URL` references remain valid.
- **Reverse proxy** terminates TLS (e.g. Caddy for automatic certificates),
  serves the static React build, and proxies `/api` + `/ws` to the API service.
- **Postgres** and **Redis** run as containers with **persistent volumes**.

> Single-VPS is the goal; the design avoids anything that *requires* multiple
> nodes. Extracting the worker or bot-runner onto its own host later is a compose
> change, not a redesign.

## 2. Alpaca integration

The only component that talks to Alpaca is the **worker**. This centralizes
credentials and rate limiting.

- **Endpoints used:** market-data bars for the full S&P 500; historical bars API
  for backfill. tickr does **not** route real orders to Alpaca — fills are
  internal, priced from TimescaleDB ([04-game-mechanics](04-game-mechanics.md#41-fill-model-v1)).
- **Symbol set:** all current S&P 500 components (~500 symbols), always. Theme
  membership does not affect which symbols the worker polls.
- **Cadence:** one poll loop on the snapshot interval (default 5 min); appends
  each bar to the `price_bar` hypertable. No Redis quote cache — consumers read
  TimescaleDB directly.
- **Backfill:** when a symbol is added to `universe_symbol`, a cron job fetches
  5 years of 5-min bars via the Alpaca historical data API and bulk-inserts them.
  Rate limiting for backfill uses the same token-bucket in Redis as the live
  poll; they share the Alpaca quota.
- **Rate limiting:** token-bucket in Redis; both the live poll and backfill cron
  back off on `429`. No other component may call Alpaca.
- **Credentials:** Alpaca API key/secret are server-side env only, never sent to
  the browser.

> **Alpaca tier: Algo Trader ($9/mo).** Provides real-time WebSocket bar data.
> Historical bar depth and rate limits for the 500-symbol backfill load must be
> verified against current Alpaca docs at implementation time — see open question
> T2b in [09-open-questions](09-open-questions.md#timeseries--backtesting). The
> token-bucket in Redis absorbs any quota changes without touching application
> logic.

## 3. Configuration & secrets

All via environment / a secrets file mounted into containers (never committed):

| Secret / config | Used by |
|---|---|
| `DATABASE_URL` | api, worker, bot-runner |
| `REDIS_URL` | api, worker, bot-runner |
| `ALPACA_KEY` / `ALPACA_SECRET` | worker only |
| `GOOGLE_OAUTH_CLIENT_ID/SECRET` | api |
| `GITHUB_OAUTH_CLIENT_ID/SECRET` | api |
| `SESSION_SIGNING_KEY` | api |
| `ADMIN_BOOTSTRAP` (allowlisted provider subjects) | api |
| `PUBLIC_BASE_URL` | api (OAuth redirect URIs) |

## 4. Data persistence & backups

- Postgres + TimescaleDB is the system of record: users, seasons, portfolios,
  orders, fills, snapshots, leaderboard rows, and the `price_bar` OHLCV history.
  **Back it up** (scheduled `pg_dump` to off-VPS storage). TimescaleDB hypertable
  data is included in a standard `pg_dump`. Snapshots + fills + bars being
  immutable/append-only makes point-in-time reasoning easy.
- Redis is a cache/queue: treat as **rebuildable**. Quote cache and leaderboard
  cache can be regenerated. **Job queue durability: re-enqueue on boot.** The
  worker checks for in-progress or missed jobs on startup and re-queues them using
  idempotency keys to avoid double-execution. No Redis persistence mode required.

## 5. Scheduled / background jobs

Run by the worker (and bot-runner):

| Job | Cadence | Effect |
|---|---|---|
| Quote poll | every snapshot interval (5 min default) | fetch all S&P 500 bars from Alpaca; append to `price_bar` hypertable |
| Backfill cron | on `universe_symbol` insert (or periodic sweep for `backfilled = false`) | fetch 5 years of 5-min bars per new symbol; set `backfilled = true` when done |
| Valuation snapshot | `season.snapshotIntervalSec` | read latest prices from `price_bar`; write snapshots; recompute leaderboard; refresh Redis leaderboard cache |
| Season transitions | on schedule / at boundaries | `scheduled→active`, `active→settling→closed` |
| Bot/algo cycle | each snapshot interval | strategies read latest prices from `price_bar`; decide → submit orders |

Jobs must be **idempotent** and safe to re-run after a crash (snapshots keyed by
`taken_at`; orders keyed by idempotency key).

## 6. Observability

Minimum viable:

- **Logs:** structured JSON; correlate by request id / job id.
- **Metrics:** API latency + error rate; Alpaca call count, error rate, 429s;
  snapshot duration + lag; queue depth; bot-cycle duration.
- **Admin ops view:** `GET /admin/seasons/:id/ops`
  ([03-api](03-api.md#8-admin)) surfaces snapshot lag and Alpaca health for the
  running game.
- **Alerts (TODO):** snapshot lag exceeding threshold; sustained Alpaca errors;
  queue backlog.

## 7. Environments

- **dev** — local compose; separate OAuth app registrations + redirect URIs; an
  Alpaca paper key. Themes can use a tiny symbol set.
- **prod** — the VPS; distinct OAuth registrations and Alpaca credentials.

## 8. Security posture

- TLS everywhere; HSTS at the proxy.
- Secrets server-side only; nothing sensitive reaches the client.
- DB/Redis bound to the internal network, not publicly exposed.
- Principle of least privilege between components (only worker holds Alpaca keys;
  only api holds OAuth secrets).
- See [05-auth](05-auth.md) for the auth-specific threat table.

## 9. Ops decisions (resolved)

- **Alpaca tier:** Algo Trader ($9/mo), real-time WebSocket bars (see §2).
- **Queue durability:** re-enqueue on boot; idempotency keys prevent double-run.
- **Backups:** daily `pg_dump` to off-VPS storage (e.g. Hetzner Object Storage or
  B2); 7-day retention; periodic restore drill before each new season.
- **Backend roles:** one image, role selected by `ROLE` env var. Split into
  separate images only if independent deploy cadences or resource isolation
  becomes necessary.
