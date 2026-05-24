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
        ┌───▼────────┐
        │  Finnhub   │
        │ (WS + REST)│
        └────────────┘
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

- **Live pricing — WebSocket (primary):** the worker maintains a persistent
  WebSocket connection to Finnhub, subscribing to all watch-list symbols. Each
  trade event appends to `price_bar`. Free tier: ≤50 simultaneous subscriptions.
  Paid tiers: unlimited. Symbols beyond the subscription limit fall back to REST.
- **Live pricing — REST fallback:** `GET /quote` per symbol at the snapshot
  interval, for any symbol not covered by an active WebSocket subscription.
- **Backfill:** `GET /stock/candle?resolution=5` per symbol for 5 years of
  5-min bars, triggered when a symbol enters the watch list with
  `universe_symbol.backfilled = false`. Bulk-inserts into `price_bar`; sets
  `backfilled = true` on completion.
- **Rate limiting:** 60 req/min (free tier); token-bucket in Redis. REST
  fallback and backfill cron share the bucket; WebSocket traffic does not
  consume REST quota. No other component may call Finnhub.
- **Credentials:** `FINNHUB_API_KEY` is server-side env only, never sent to
  the browser.

> **Finnhub tier: Free ($0/mo)** viable for watch lists ≤50 symbols.
> Paid tiers start at ~$11.99/mo and raise the WebSocket symbol limit and
> REST quota. **Commercial licensing terms must be confirmed before public
> launch** (open question F1). Historical bar depth needs verification (T2b).
> See [09-open-questions](09-open-questions.md#finnhub-integration).

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

Run by the worker (and bot-runner):

| Job | Cadence | Effect |
|---|---|---|
| Finnhub WebSocket | persistent | subscribe to watch-list symbols; on trade event append to `price_bar` |
| REST fallback poll | every snapshot interval (5 min default) | `GET /quote` for overflow symbols not on WebSocket; append to `price_bar` |
| Backfill cron | on season activation; sweep `backfilled = false` symbols | `GET /stock/candle` per symbol for 5 years of 5-min bars; set `backfilled = true` |
| Valuation snapshot | `season.snapshotIntervalSec` (default 300 s) | read latest prices from `price_bar`; write snapshots; rank portfolios; refresh Redis leaderboard cache |
| Season transitions | scheduled / at boundaries | `scheduled→active`, `active→settling→closed` |
| Bot/algo cycle | each snapshot interval | strategies read latest prices from `price_bar`; decide → submit orders |

All jobs must be **idempotent** and safe to re-run after a crash (snapshots
keyed by `taken_at`; orders keyed by idempotency key; backfill guarded by
`backfilled` flag).

## 6. Observability

Minimum viable:

- **Logs:** structured JSON; correlate by request ID / job ID.
- **Metrics:** API latency + error rate; Finnhub WebSocket connection state,
  event rate, reconnect count; REST fallback call count + 429 rate; snapshot
  duration + lag; backfill progress per symbol; queue depth; bot-cycle duration.
- **Admin ops view:** `GET /admin/seasons/:id/ops`
  ([03-api](03-api.md#8-admin)) surfaces snapshot lag and Finnhub feed health
  for the running game.
- **Alerts (TODO):** snapshot lag exceeding threshold; Finnhub WebSocket
  disconnected for > N minutes; sustained REST 429s; queue backlog.

## 7. Environments

- **dev** — local Compose; separate OAuth app registrations + redirect URIs;
  Finnhub free-tier key. Themes can use a tiny symbol set (5–10 symbols) to
  keep backfill fast.
- **prod** — the VPS; distinct OAuth registrations; production Finnhub key
  (upgrade tier if watch list exceeds 50 symbols).

## 8. Security posture

- TLS everywhere; HSTS at the proxy.
- Secrets server-side only; nothing sensitive reaches the browser.
- DB/Redis bound to the internal Docker network, not publicly exposed.
- Principle of least privilege: only the worker holds the Finnhub key; only
  the API holds OAuth secrets.
- See [05-auth](05-auth.md) for the auth-specific threat table.

## 9. Ops decisions (resolved)

- **Market data provider:** Finnhub; free tier ($0/mo) for watch lists ≤50
  symbols; upgrade to paid (~$11.99/mo+) if larger (see §2 and F2 in
  [09-open-questions](09-open-questions.md)).
- **Queue durability:** re-enqueue on boot; idempotency keys prevent double-run.
- **Backups:** daily `pg_dump` to off-VPS storage; 7-day retention; restore
  drill before each new season.
- **Backend roles:** one image, role selected by `ROLE` env var. Split into
  separate images only if independent deploy cadences or resource isolation
  becomes necessary.
