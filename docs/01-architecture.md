# 01 — Architecture

> This doc describes **v1 architecture in the body** and previews v2+ at the
> end. v1 is intentionally small: one image with three roles, Postgres +
> TimescaleDB, Redis, and Finnhub over REST. v2 introduces seasons/themes and
> WebSocket streaming; v3 introduces user-authored algos. The component
> boundaries below are chosen so each phase is additive.

## 1. v1 component overview

```
                         ┌──────────────────────────────┐
   Browser (React/TS) ───┤  Caddy (TLS + static + /api + /ws)  │
                         └───────────────┬──────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                 │
┌───────▼────────┐              ┌────────▼────────┐               ┌────────▼────────┐
│  API service   │              │  Worker service  │               │  Bot runner     │
│ (auth, orders, │              │ (backfill,       │               │ (the one v1     │
│  reads, /ws)   │              │  daily price,    │               │  buy-and-hold   │
│                │              │  EOD snapshot)   │               │  bot)           │
└───┬────────┬───┘              └───────┬─────────┘               └────────┬────────┘
    │        │                          │                                  │
    │        └─────────────┬────────────┴──────────────┬───────────────────┘
    │                      │                            │
┌───▼──────────────────┐  ┌──────▼──────┐   outbound only (worker)
│Postgres + TimescaleDB│  │   Redis     │   ┌──────────────┐
│(SoR + price_bar)     │  │(cache/queue)│   │ Finnhub REST │
└──────────────────────┘  └─────────────┘   └──────────────┘
```

All three roles (`api`, `worker`, `bot`) ship from **one image**; the `ROLE`
env var selects which loop runs. Compose runs them as three containers on a
single Hetzner VPS.

### 1.1 Responsibilities (v1)

- **Caddy** — TLS termination, routing, static frontend delivery, WebSocket
  upgrade. See [08-deployment](08-deployment.md).
- **API service** — Stateless HTTP + WebSocket: auth/session, order
  submission, portfolio reads, leaderboard reads, the `/me` endpoint, and the
  small admin surface. Talks to Postgres and Redis; never calls Finnhub on
  the request path.
- **Worker service** — Scheduled background work: the one-time bootstrap
  backfill, the once-daily price update, and the daily EOD valuation
  snapshot. Holds the only Finnhub API key.
- **Bot runner** — Runs the single v1 house bot (`index`, a buy-and-hold of
  an equally-weighted S&P 500 basket) once at portfolio creation. There is no
  per-cycle bot loop in v1 — the bot's portfolio doesn't trade after seeding.
- **Postgres + TimescaleDB** — System of record (`app_user`, `identity`,
  `portfolio`, `position`, `trade_order`, `fill`, `algo`, `universe_symbol`,
  `valuation_snapshot`, `leaderboard_row`) plus the OHLCV `price_bar`
  hypertable. TimescaleDB runs as a Postgres extension (same service, same
  `DATABASE_URL`); no separate process.
- **Redis** — Job queue, Finnhub rate-limit token bucket, leaderboard read
  cache. Not used for price data — TimescaleDB is authoritative for all
  pricing.

> **Deployment note:** API service, worker, and bot runner run as three
> processes of the same codebase (one image, role selected by `ROLE` env
> var). Logical separation matters more than physical separation on day one;
> we can split them later without redesign.

## 2. v1 data flows

### 2.1 Market data ingestion (REST-only)

v1 has no themes and no watch list. The full S&P 500 is the tradeable
universe, populated in `universe_symbol`. Two ingestion paths exist:

**Bootstrap backfill (one-time, on system install):**
```
Worker (on first boot, if any universe_symbol has backfilled = false):
  → for each unbackfilled symbol:
      GET /stock/candle?resolution=5 — 5 years of 5-min bars
      bulk-insert into price_bar
      set universe_symbol.backfilled = true (symbol becomes tradeable)
  → respect 60 req/min token bucket (free tier)
  → restart-safe: re-run picks up where it left off
```

**Daily price update (cron, once per US market close):**
```
Worker (daily after 16:00 ET):
  → for each universe_symbol with backfilled = true:
      GET /quote
      append one row to price_bar (ts = today's close)
  → 500 symbols ÷ 60 req/min ≈ 8.5 min total
```

**~49 M rows** for the full 500-symbol corpus (500 × 5y × 252 trading days
× 78 five-minute bars/day). Bootstrap is a one-shot cost; the daily update
adds 500 rows/day. Finnhub historical depth + `/stock/candle` per-call
window need verification — see
[09-open-questions](09-open-questions.md#open-finnhub-questions).

### 2.2 Order submission

```
Client (or seed flow for the index bot)
  → POST /portfolios/:id/orders (idempotency key)
  → API validates: portfolio owned by caller, symbol ∈ universe_symbol with
                    backfilled = true, quantity > 0, sufficient cash (buys)
                    or sufficient position (sells)
  → order persisted as ACCEPTED (or REJECTED with reason)
  → fill computed against latest cached price (see fill model below)
  → portfolio cash + positions updated transactionally
  → emit event (WS push + audit log)
```

**Fill model (v1):** immediate fill at the `close` of the most recent
`price_bar` row for the symbol, queried from TimescaleDB. Because v1
updates prices once daily, during the trading day the most recent close is
the prior trading day's (after 16:30 ET it is today's; on Monday morning
it is Friday's). This is intentional — it matches the EOD snapshot cadence
and removes any intraday latency edge. Limit orders, slippage, and partial
fills are deferred.

### 2.3 EOD valuation + leaderboard

```
Worker (daily after the daily price update completes):
  prices = SELECT symbol, close FROM price_bar
           WHERE ts = (latest ts per symbol)
           -- served from TimescaleDB
  for each portfolio:
    equity = cash + Σ(position.qty × prices[symbol])
  write valuation_snapshot rows (one per portfolio, keyed by taken_at)
  rank portfolios by equity → write leaderboard_row rows
  refresh Redis leaderboard cache
  emit leaderboard.updated WS event
```

The leaderboard the user sees is read from the most recent snapshot, **not**
recomputed per request. In v1 this means the ranking updates **once per day**
after the EOD job runs. Intraday equity is shown best-effort on the
portfolio view (cash + Σ qty × latest known close), but it doesn't change
the official ranking until the next EOD snapshot.

## 3. Language strategy

- **Default: TypeScript.** Frontend is TypeScript, period. Backend is
  Node.js + TypeScript so types can be **shared** across the wire
  (see [03-api](03-api.md) and [06-frontend](06-frontend.md)).
- **Escape hatch: a compiled language (Go preferred).** If profiling shows
  a hot path is too slow in Node — most likely candidates are the EOD
  snapshot loop or the v3 bot runner under many concurrent algos — that
  component may be rewritten in Go. Component boundaries above are chosen so
  this is a *replace one box* operation.
- **Contract discipline:** Inter-service contracts are defined as
  language-neutral schemas (OpenAPI for the public API; TypeScript shared
  package `@tickr/shared-types` for internal boundaries) so a Go rewrite
  consumes the same contracts.

## 4. Cross-cutting concerns (v1)

| Concern | Approach |
|---|---|
| **Rate limiting (Finnhub)** | Centralized in worker; token-bucket in Redis (60 req/min on free tier). Bootstrap backfill and daily price update share the bucket. No other component calls Finnhub. |
| **Rate limiting (our API)** | Per-user + per-IP counters in Redis; stricter limits for order endpoints. Concrete numbers defined at implementation time. |
| **Idempotency** | Order submission accepts a client idempotency key; duplicates return the original result. |
| **Time** | All timestamps UTC, ISO-8601 at the boundary. EOD job uses the US/Eastern market close; the snapshot's `taken_at` is in UTC. |
| **Auditability** | Orders, fills, and snapshots are append-only/immutable records. Leaderboard is derived and reproducible from snapshots. |
| **Observability** | Structured JSON logs + a small metric set (snapshot lag, REST 429s, daily-job duration, queue depth). See [08-deployment §6](08-deployment.md#6-observability). |
| **Config/secrets** | Env-injected; Finnhub key and OAuth client secrets never reach the client. See [05-auth](05-auth.md) and [08-deployment](08-deployment.md#3-configuration--secrets). |

## 5. Trust boundaries

1. **Browser ↔ API** — untrusted client; all validation server-side.
2. **API/Worker ↔ Postgres/Redis** — trusted internal Docker network.
3. **Worker ↔ Finnhub** — outbound only; credentials server-side only.
4. **Bot runner ↔ strategy code** — in v1, the bot runs in-process from a
   trusted module; *the* sensitive boundary opens up in v3 with
   user-authored algos. See
   [07-bots-and-algos](07-bots-and-algos.md#12-deferred-arbitrary-user-code).

## 6. v2+ outlook

v2 introduces **seasons** and **themes**:

- A `season` table wraps the v1 perpetual portfolio in a bounded
  competition (start/end, lifecycle: `draft → scheduled → active → settling
  → closed`). v1 `portfolio` rows are migrated under a single "legacy"
  season (or kept as `season_id IS NULL` for the perpetual board, depending
  on the migration choice — see [02-data-model](02-data-model.md#5-v2-schema-outlook)).
- A `theme` + `theme_symbol` pair defines a curated symbol universe per
  season. The watch list becomes the union of active seasons' themes
  (re-derived each cycle).
- The single v1 bot expands into the **strategy registry** in
  [07-bots-and-algos](07-bots-and-algos.md). The bot runner gains a per-cycle
  loop (one cycle = one snapshot interval).
- The Finnhub WebSocket connection enters here: with smaller per-season
  watch lists and per-snapshot cadence, live quotes become useful. The REST
  path remains as a fallback for overflow symbols. See
  [08-deployment §2](08-deployment.md#2-finnhub-integration).

v3 introduces **user-authored algos**: declarative strategy types
parameterized by user config, capped per user per season. Arbitrary user
code remains deferred — if pursued, sandboxed (WASM/isolate) or webhook.
This is the sensitive trust boundary called out in §5.4 above.
