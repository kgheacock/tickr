# 01 — Architecture

## 1. Component overview

tickr is a small number of cooperating services running on a single VPS. The
shape below is deliberately modest; the boundaries are drawn so a component can
be extracted or rewritten (e.g. in Go) without rippling through the rest.

```
                         ┌──────────────────────────────┐
   Browser (React/TS) ───┤  Web/API gateway (HTTP + WS)  │
                         └───────────────┬──────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                 │
┌───────▼────────┐              ┌────────▼────────┐               ┌────────▼────────┐
│  API service   │              │  Worker service  │               │  Bot runner     │
│ (auth, trades, │              │ (valuation, snap │               │ (house + user   │
│  leaderboard)  │              │  shots, jobs)    │               │  algo execution)│
└───┬────────┬───┘              └───────┬─────────┘               └────────┬────────┘
    │        │                          │                                  │
    │        └─────────────┬────────────┴──────────────┬───────────────────┘
    │                      │                            │
┌───▼──────────────────┐  ┌──────▼──────┐  ┌──────▼───────┐
│Postgres + TimescaleDB│  │   Redis     │  │ Alpaca API   │
│(SoR + OHLCV history) │  │(cache/queue)│  │ (market data)│
└──────────────────────┘  └─────────────┘  └──────────────┘
```

### Responsibilities

- **Web/API gateway** — TLS termination, routing, static frontend delivery,
  WebSocket upgrade. Likely a reverse proxy (Caddy/nginx) in front of the API
  service. See [08-deployment](08-deployment.md).
- **API service** — Stateless request handling: auth/session, order submission,
  portfolio reads, leaderboard reads, admin endpoints. Talks to Postgres and
  Redis; never calls Alpaca on the synchronous request path for pricing (it reads
  cached prices).
- **Worker service** — Scheduled and queued background work: pulling quotes from
  Alpaca on a cadence, producing **valuation snapshots**, computing leaderboard
  rankings, season open/close transitions, fill settlement.
- **Bot runner** — Executes house bots and user algorithmic strategies on a
  schedule, translating their decisions into orders through the same internal
  order pathway humans use. Isolated so a misbehaving algo cannot take down the
  API. See [07-bots-and-algos](07-bots-and-algos.md).
- **Postgres + TimescaleDB** — System of record for all game entities (users,
  seasons, portfolios, orders, fills, snapshots, leaderboard rows) plus the
  OHLCV `price_bar` hypertable for historical price data. TimescaleDB runs as
  a Postgres extension (same service, same `DATABASE_URL`); no separate process.
  See [02-data-model §2.11](02-data-model.md#211-price_bar-timescaledb).
- **Redis** — Job queue, rate-limit counters (Alpaca + API), ephemeral session
  helpers, leaderboard read cache. **Not** used for quote/price data; TimescaleDB
  is authoritative for all pricing.

> **Deployment note:** API service, worker, and bot runner *may* run as three
> processes of the same codebase initially (one binary/image, role selected by
> env var). The logical separation matters more than the physical one on day one.

## 2. Core data flows

### 2.1 Market data ingestion (watch list)

The worker polls only the **watch list** — the set of symbols currently in
scope. In v1 this is the union of symbols across all active seasons' themes.
The S&P 500 is the upper bound on what can ever appear in the watch list, not
the polling scope. This keeps Alpaca load proportional to actual game activity.

```
Watch list (derived, re-evaluated each poll cycle):
  SELECT DISTINCT ts.symbol
  FROM theme_symbol ts
  JOIN season s ON s.theme_id = ts.theme_id
  WHERE s.status = 'active'
```

```
Worker (live poll, every snapshot interval):
  → compute watch list
  → fetch latest bars for watch list symbols from Alpaca (SIP feed)
  → append OHLCV bar rows to price_bar hypertable (TimescaleDB)
  → (no Redis quote cache — consumers read TimescaleDB directly)
```

```
Backfill cron (runs on season activation or periodic sweep):
  → new_to_watch = watch list symbols WHERE universe_symbol.backfilled = false
  → for each: fetch 5 years of 5-min bars from Alpaca (SIP feed)
  → bulk-insert into price_bar
  → mark universe_symbol.backfilled = true (symbol becomes tradeable)
```

**~49 M rows** for a full 500-symbol corpus (500 × 5 years × 252 trading days
× 78 five-minute bars/day). In practice a per-theme backfill covers 7–50
symbols (~490–4,900 API requests, under 25 minutes at the 200 req/min rate
limit). Alpaca SIP feed provides 5-min bar history back to at least 2016
(confirmed). See [09-open-questions T2b](09-open-questions.md) — resolved.

The watch list is designed to expand beyond active seasons (e.g. to support
pre-season prep or user-defined watchlists) without redesign. See
[02-data-model §2.11](02-data-model.md#211-watch_list) for the data model and
[08-deployment](08-deployment.md#alpaca-integration) for Alpaca tier notes.

### 2.2 Order submission (human or bot)

```
Client / Bot runner
  → POST order (idempotency key)
  → API validates: season active? symbol in theme? sufficient buying power?
  → order persisted as ACCEPTED (or REJECTED with reason)
  → fill computed against latest cached price (see fill model below)
  → portfolio cash + positions updated transactionally
  → emit event (WS push + audit log)
```

**Fill model:** immediate fill at the `close` price of the most recent
`price_bar` row for the symbol, queried from TimescaleDB. Limit orders,
slippage, and partial fills are deferred.

### 2.3 Valuation + leaderboard

```
Worker (snapshot cadence, e.g. every N minutes / EOD)
  → for each active season:
      prices = SELECT symbol, close FROM price_bar
               WHERE symbol IN (season theme) AND ts = (latest ts per symbol)
               -- served from TimescaleDB
      for each portfolio:
        equity = cash + Σ(position.qty × prices[symbol])
      write valuation_snapshot rows
      rank portfolios by equity → write leaderboard rows
  → invalidate/refresh Redis leaderboard cache
```

The leaderboard the user sees is read from the most recent snapshot, **not**
recomputed per request. This decouples ranking from live quote volatility and
makes rankings reproducible/auditable.

## 3. Language strategy

- **Default: TypeScript.** Frontend is TypeScript, period. Backend is Node.js +
  TypeScript by default so types can be **shared** across the wire (see
  [03-api](03-api.md) and [06-frontend](06-frontend.md)).
- **Escape hatch: a compiled language (Go preferred).** If profiling shows a hot
  path is too slow in Node — most likely candidates are the valuation/snapshot
  loop or the bot runner under many concurrent algos — that component may be
  rewritten in Go (or similar). The component boundaries above are chosen so this
  is a *replace one box* operation, not a rewrite.
- **Contract discipline:** Inter-service contracts (HTTP/queue payloads) are
  defined as language-neutral schemas (see [02-data-model](02-data-model.md) and
  [03-api](03-api.md)) so a Go rewrite consumes the same contracts.

> **TODO:** Decide the serialization/contract source of truth that survives a
> polyglot future — candidates: OpenAPI + JSON, or Protobuf. Leaning OpenAPI/JSON
> for the public API and a shared schema package for internal types. Tracked in
> [09-open-questions](09-open-questions.md).

## 4. Cross-cutting concerns

| Concern | Approach |
|---|---|
| **Rate limiting (Alpaca)** | Centralized in worker; token-bucket in Redis (200 req/min). No other component calls Alpaca. Live poll covers only the watch list; backfill cron shares the same bucket. |
| **Rate limiting (our API)** | Per-user + per-IP counters in Redis; stricter limits for order/algo endpoints. |
| **Idempotency** | Order submission accepts a client idempotency key; duplicates return the original result. |
| **Time** | All timestamps UTC, ISO-8601 at the boundary. Market hours handled in worker logic. **TODO:** define behavior outside market hours. |
| **Auditability** | Orders, fills, and snapshots are append-only/immutable records. Leaderboard is derived and reproducible from snapshots. |
| **Observability** | Structured logs + basic metrics (request latency, Alpaca call count/error rate, snapshot duration, queue depth). |
| **Config/secrets** | Env-injected; Alpaca keys and OAuth client secrets never reach the client. See [05-auth](05-auth.md) and [08-deployment](08-deployment.md). |

## 5. Trust boundaries

1. **Browser ↔ API** — untrusted client; all validation server-side.
2. **API/Worker ↔ Postgres/Redis** — trusted internal network on the VPS.
3. **Worker ↔ Alpaca** — outbound only; credentials server-side only.
4. **Bot runner ↔ user algo code** — *the* sensitive boundary. User-authored
   algorithmic strategies must be sandboxed / resource-capped. The initial,
   safest design avoids running arbitrary user code in-process; see
   [07-bots-and-algos](07-bots-and-algos.md#execution-model) for the proposed
   "declarative strategy" first cut and the deferred "arbitrary code" option.
