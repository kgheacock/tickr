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
     │+Timescale    └─────────┘
     └────────┘
            │ outbound only (worker)
        ┌───▼────────────┐
        │  Finnhub       │
        │ REST (v1)      │
        │ + WS (v2+)     │
        └────────────────┘
```

- **Containerized** with Docker Compose: proxy, api, worker, bot-runner,
  postgres, redis. API/worker/bot-runner may be the **same image** with a role
  selected by env var initially.
- **TimescaleDB** runs as a Postgres extension inside the `postgres` container
  (use the `timescale/timescaledb-ha` image instead of stock `postgres`). No
  additional service or port; all `DATABASE_URL` references remain valid.
- **Reverse proxy** (Caddy recommended for automatic TLS) terminates HTTPS,
  serves the static React build, and proxies `/api` + `/ws` to the API service.
- **Postgres** and **Redis** run as containers with **persistent volumes**.

> Single-VPS is the goal; the design avoids anything that *requires* multiple
> nodes. Extracting the worker or bot-runner onto its own host later is a
> Compose change, not a redesign.

## 2. Finnhub integration

The only component that talks to Finnhub is the **worker**. This centralizes
credentials and rate limiting. Finnhub authenticates via a single API key
(query param or header); no secret required.

**v1 is REST-only.** Because v1 uses a daily EOD snapshot cadence, intraday
streaming adds no game value. The worker uses two REST endpoints:

- **Bootstrap backfill — `GET /stock/candle?resolution=5`:** one-time at
  install, per `universe_symbol` row with `backfilled = false`. Loads 5
  years of 5-minute OHLCV bars per symbol; bulk-inserts into `price_bar`;
  sets `backfilled = true` on completion. Restart-safe — re-running the job
  picks up where it left off. Total: ~49 M rows for a full 500-symbol corpus
  (500 × 5 y × 252 trading days × 78 five-min bars/day).
- **Daily price update — `GET /quote`:** once per day, just after the US
  market close (16:00 ET). Fetches the latest quote per backfilled symbol
  and appends one row to `price_bar`. At 60 req/min, 500 symbols ≈ 8.5 min.
- **Rate limiting:** 60 req/min (free tier); token-bucket in Redis. Both
  REST jobs share the bucket. The bootstrap backfill is throttled to leave
  headroom for the daily update if both are eligible to run.
- **Credentials:** `FINNHUB_API_KEY` is server-side env only, never sent to
  the browser.

> **Finnhub tier (v1): Free ($0/mo)** is sufficient. v1 has no WebSocket
> usage and one REST burst per day. **Commercial licensing terms must be
> confirmed before public launch** (open question F1); historical depth and
> `/stock/candle` per-call window need verification (T2b).
> See [09-open-questions](09-open-questions.md#open-finnhub-questions).

> **v2 adds WebSocket streaming.** When seasons + themes land, the watch
> list narrows from "all 500" to "the union of active themes" — typically
> ≤50 symbols, which fits the free-tier WebSocket limit. The worker grows
> a persistent WS connection (primary live path) with REST `/quote` as
> overflow fallback. The token bucket above continues to govern REST; WS
> traffic does not consume REST quota.

## 3. Configuration & secrets

All via environment variables / a secrets file mounted into containers (never
committed to the repo):

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

- **Postgres + TimescaleDB** is the system of record: users, seasons,
  portfolios, orders, fills, snapshots, leaderboard rows, and the `price_bar`
  OHLCV history. Back it up with a scheduled `pg_dump` to off-VPS storage
  (e.g. Hetzner Object Storage or B2); 7-day retention. TimescaleDB hypertable
  data is included in a standard `pg_dump`. Snapshots, fills, and bars are all
  immutable/append-only — point-in-time reasoning is straightforward.
- **Redis** is rebuildable: the leaderboard cache regenerates from snapshots;
  the job queue re-enqueues on boot. No Redis persistence mode required.

> Restore drill: run a full restore to a throwaway container before each new
> season to confirm backup integrity.

## 5. Scheduled / background jobs

v1 has a small, focused job set run entirely by the worker container. The
bot-runner container is idle most of the time in v1 (the `index` bot only
trades at portfolio seeding).

| Job | Cadence | Effect |
|---|---|---|
| Bootstrap backfill | one-time at install (resumable) | for each `universe_symbol` with `backfilled = false`: `GET /stock/candle?resolution=5` for 5 y of 5-min bars; bulk-insert into `price_bar`; flip `backfilled = true` |
| Daily price update | once daily after 16:00 ET | `GET /quote` for every backfilled `universe_symbol`; append one row to `price_bar`; respect 60 req/min Redis token bucket |
| EOD valuation snapshot | once daily, immediately after the daily price update completes | read latest `price_bar.close` per held symbol; write `valuation_snapshot` rows; rank portfolios → `leaderboard_row`; refresh Redis leaderboard cache; emit `leaderboard.updated` WS event |
| Index bot seeding | once at system bootstrap | create the `index` algo + portfolio; place 500 market buys (one per backfilled symbol); the bot does not trade again |

All jobs must be **idempotent** and safe to re-run after a crash:

- Bootstrap backfill is guarded by `universe_symbol.backfilled`; re-runs skip
  completed symbols.
- Daily price update keys on `(symbol, ts)` in `price_bar` (PK); double-runs
  are no-ops (or `ON CONFLICT DO NOTHING`).
- EOD snapshot rows are keyed by `(portfolio_id, taken_at)` (UNIQUE); the
  snapshot is computed for the calendar day's close.
- Orders carry idempotency keys (UNIQUE per `portfolio_id`); the bot's
  500-order seed uses deterministic keys so retries are safe.

> **v2 adds** a per-snapshot scheduler (every `season.snapshotIntervalSec`,
> default 300 s) replacing the daily EOD job, plus a season-transition job
> (`scheduled→active`, `active→settling→closed`) and a per-cycle bot-runner
> loop driving the registry. v3 adds user-algo execution into the same loop.

## 6. Observability

Minimum viable for v1 — a small metric set, structured logs, and one admin
endpoint. No Prometheus/Grafana stack in v1; that's a v2+ expansion.

- **Logs:** structured JSON to stdout (Compose captures); each entry carries
  `request_id` (HTTP) or `job_id` (worker) so a request or a job run can be
  correlated end-to-end. Log levels: `debug | info | warn | error`.
- **Metrics:** counters and gauges exposed in-process and read via the admin
  ops endpoint below. The v1 set is intentionally small:
  - API: request count + latency p50/p95 per route; error rate by status.
  - Finnhub REST: call count, 429 count (last 24h), backfill progress
    (`universe_symbol where backfilled = false` count).
  - Daily price update: last-run timestamp, duration, count of bars written.
  - EOD snapshot: last-run timestamp, duration, snapshot lag
    (`now() - last_snapshot.taken_at`).
  - Redis: queue depth (job count), Finnhub token-bucket remaining.
- **Admin ops view:** `GET /admin/ops` ([03-api §6](03-api.md#6-admin-v1))
  surfaces snapshot lag, Finnhub 429s, queue depth, and backfill remaining
  for at-a-glance health checks.
- **Alerts (TODO):** snapshot lag > 26 h (missed a day);
  sustained Finnhub 429s; backfill stuck (no progress for > 1 h while rows
  remain). v1 can do these as email/Discord webhooks from the worker;
  alerting infra is a v2+ concern.

> **v2 expands** the metric set with WebSocket connection state + event
> rate + reconnect count, per-snapshot duration (not just daily), bot-cycle
> duration, and per-season lag. v2+ also introduces a real metrics endpoint
> (`/metrics` Prometheus-format) and dashboards if/when ops demands it.

## 7. Environments

- **dev** — local Compose; separate OAuth app registrations + redirect URIs;
  Finnhub free-tier key. To keep the bootstrap backfill fast, seed
  `universe_symbol` with a small subset (5–10 symbols) instead of the full
  S&P 500.
- **prod** — the VPS; distinct OAuth registrations; production Finnhub key.
  v1 stays on the free tier (REST-only). v2 evaluates the paid tier when
  per-season WebSocket subscriptions become useful.

## 8. Security posture

- TLS everywhere; HSTS at the proxy.
- Secrets server-side only; nothing sensitive reaches the browser.
- DB/Redis bound to the internal Docker network, not publicly exposed.
- Principle of least privilege: only the worker holds the Finnhub key; only
  the API holds OAuth secrets.
- See [05-auth](05-auth.md) for the auth-specific threat table.

## 9. Ops decisions

Consolidated in [09-open-questions](09-open-questions.md) — see the
**v1 deployment / Finnhub** and **all phases — backend language** sections
for the canonical record. This section used to duplicate that list; it now
just points there to avoid drift.
