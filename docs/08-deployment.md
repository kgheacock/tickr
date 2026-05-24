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

## 2. Finnhub integration

The only component that talks to Finnhub is the **worker**. This centralizes
credentials and rate limiting. Finnhub uses a single API key (query param or
header); no secret required.

- **Live pricing — WebSocket (primary):** the worker maintains a persistent
  WebSocket connection, subscribing to watch-list symbols. Each trade event
  updates the latest price and feeds `price_bar`. Free tier: ≤50 simultaneous
  symbol subscriptions. Paid tiers: unlimited. If the watch list exceeds the
  subscription limit, overflow symbols fall back to REST polling.
- **Live pricing — REST fallback:** `GET /quote` per symbol at the snapshot
  interval, for any symbol not covered by the active WebSocket subscription.
- **Backfill:** `GET /stock/candle?resolution=5` per symbol for 5 years of
  5-min bars, triggered when a symbol enters the watch list with
  `universe_symbol.backfilled = false`. Bulk-inserts into `price_bar`; sets
  `backfilled = true` on completion.
- **Rate limiting:** 60 req/min (free tier); token-bucket in Redis; REST
  fallback and backfill cron share the bucket. WebSocket traffic does not
  consume REST quota. No other component may call Finnhub.
- **Credentials:** `FINNHUB_API_KEY` is server-side env only, never sent to
  the browser.

> **Finnhub tier: Free ($0/mo) viable for watch lists ≤50 symbols.** Real-time
> WebSocket quotes included. REST rate limit: 60 req/min. Paid tiers start at
> ~$11.99/mo and increase the WebSocket symbol limit and REST quota. Commercial
> licensing terms must be confirmed before public launch — see open question F1
> in [09-open-questions](09-open-questions.md#finnhub-integration).
> Historical bar depth and per-call pagination limits need verification (T2b).

## 3. Configuration & secrets

All via environment / a secrets file mounted into containers (never committed):

| Secret / config | Used by |
|---|---|
| `DATABASE_URL` | api, worker, bot-runner |
| `REDIS_URL` | api, worker, bot-runner |
| `FINNHUB_API_KEY` | worker only |
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
| Finnhub WebSocket | persistent (always-on while worker is running) | subscribe to watch-list symbols; on trade event append to `price_bar` |
| REST fallback poll | every snapshot interval (5 min default) | `GET /quote` for symbols not covered by WebSocket subscription; append to `price_bar` |
| Backfill cron | on season activation (or periodic sweep for `backfilled = false` symbols) | `GET /stock/candle` for 5 years of 5-min bars per new-to-watch symbol; set `backfilled = true` |
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

- **Alpaca tier:** Algo Trader Plus ($99/mo), real-time WebSocket bars (see §2).
- **Queue durability:** re-enqueue on boot; idempotency keys prevent double-run.
- **Backups:** daily `pg_dump` to off-VPS storage (e.g. Hetzner Object Storage or
  B2); 7-day retention; periodic restore drill before each new season.
- **Backend roles:** one image, role selected by `ROLE` env var. Split into
  separate images only if independent deploy cadences or resource isolation
  becomes necessary.
