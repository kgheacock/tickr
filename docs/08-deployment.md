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
- **Reverse proxy** terminates TLS (e.g. Caddy for automatic certificates),
  serves the static React build, and proxies `/api` + `/ws` to the API service.
- **Postgres** and **Redis** run as containers with **persistent volumes**.

> Single-VPS is the goal; the design avoids anything that *requires* multiple
> nodes. Extracting the worker or bot-runner onto its own host later is a compose
> change, not a redesign.

## 2. Alpaca integration

The only component that talks to Alpaca is the **worker**. This centralizes
credentials and rate limiting.

- **Endpoints used:** market-data (quotes/bars) for the bounded symbol set; paper
  account context as needed. tickr does **not** route real orders to Alpaca —
  fills are internal against cached prices
  ([04-game-mechanics](04-game-mechanics.md#41-fill-model-v1)).
- **Symbol set:** `DISTINCT` symbols across active seasons' themes only — kept
  small by design ([01-architecture](01-architecture.md#21-market-data-ingestion)).
- **Cadence:** one poll loop on an interval; writes to the Redis quote cache with
  a short TTL and persists periodic price points to Postgres for snapshots/history.
- **Rate limiting:** token-bucket in Redis; the loop backs off on `429`. No other
  component may call Alpaca.
- **Credentials:** Alpaca API key/secret are server-side env only, never sent to
  the browser.

> **Alpaca tier: Algo Trader ($9/mo).** Provides real-time WebSocket bar data
> and REST quote history — sufficient for a 5-minute snapshot cadence with a
> bounded symbol set. Verify exact rate limits against the current Alpaca docs at
> implementation time; the token-bucket in Redis absorbs any changes without
> touching application logic.

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

- Postgres is the system of record: users, seasons, portfolios, orders, fills,
  snapshots, leaderboard rows. **Back it up** (scheduled `pg_dump` to off-VPS
  storage). Snapshots + fills being immutable makes point-in-time reasoning easy.
- Redis is a cache/queue: treat as **rebuildable**. Quote cache and leaderboard
  cache can be regenerated. **Job queue durability: re-enqueue on boot.** The
  worker checks for in-progress or missed jobs on startup and re-queues them using
  idempotency keys to avoid double-execution. No Redis persistence mode required.

## 5. Scheduled / background jobs

Run by the worker (and bot-runner):

| Job | Cadence | Effect |
|---|---|---|
| Quote poll | every poll interval | refresh Redis quote cache; persist price points |
| Valuation snapshot | `season.snapshotIntervalSec` | write snapshots; recompute leaderboard; refresh cache |
| Season transitions | on schedule / at boundaries | `scheduled→active`, `active→settling→closed` |
| Bot/algo cycle | each snapshot interval | strategies decide → submit orders |

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
