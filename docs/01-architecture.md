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
┌───▼─────┐         ┌──────▼──────┐              ┌──────▼───────┐
│Postgres │         │   Redis     │              │ Alpaca API   │
│(SoR)    │         │(cache/queue)│              │ (market data)│
└─────────┘         └─────────────┘              └──────────────┘
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
- **Postgres** — System of record for users, seasons, portfolios, orders, fills,
  snapshots, leaderboard rows.
- **Redis** — Quote cache, job queue, rate-limit counters, ephemeral session
  helpers, leaderboard read cache.

> **Deployment note:** API service, worker, and bot runner *may* run as three
> processes of the same codebase initially (one binary/image, role selected by
> env var). The logical separation matters more than the physical one on day one.

## 2. Core data flows

### 2.1 Market data ingestion (bounded by theme)

The reason themes exist is to keep this flow cheap. Only symbols belonging to
**active seasons' themes** are polled.

```
Worker (scheduler)
  → collect DISTINCT symbols across all ACTIVE seasons' themes
  → batch-request quotes from Alpaca (respecting rate limits)
  → write {symbol → price, asOf} into Redis quote cache (short TTL)
  → persist periodic price points to Postgres for snapshot/history
```

Because the union of active themes is small (tens, not thousands, of symbols),
one polling cadence covers all seasons. See
[04-game-mechanics](04-game-mechanics.md#themes) and
[08-deployment](08-deployment.md#alpaca-integration).

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

**Fill model (TODO to finalize, see open questions):** the default proposal is
*immediate fill at last cached price* for simplicity and fairness within a
snapshot window. Limit orders, slippage, and partial fills are deferred.

### 2.3 Valuation + leaderboard

```
Worker (snapshot cadence, e.g. every N minutes / EOD)
  → for each active season:
      for each portfolio:
        equity = cash + Σ(position.qty × latest_price(symbol))
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
| **Rate limiting (Alpaca)** | Centralized in worker; token-bucket in Redis. No other component calls Alpaca for quotes. |
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
