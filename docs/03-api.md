# 03 — API

> This doc describes **v1 endpoints in the body** and previews v2+/v3+
> endpoints in §10. Interface definitions only — **not implemented**. The
> public API is REST over HTTPS with JSON bodies; live updates use a single
> authenticated WebSocket. Types reuse the entities in
> [02-data-model](02-data-model.md). The contract source-of-truth format
> is **OpenAPI + JSON** for the public API and the
> `@tickr/shared-types` package for internal types.

## 1. Conventions

- Base path: `/api/v1`.
- Auth: session cookie (HTTP-only, secure) established via SSO; see
  [05-auth](05-auth.md). Endpoints below note `auth: player|admin|public`.
- All timestamps ISO-8601 UTC. All money in integer **cents**.
- Errors use a consistent envelope:

```ts
interface ApiError {
  error: {
    code: string;        // machine-readable, e.g. "SYMBOL_NOT_TRADEABLE"
    message: string;     // human-readable
    details?: unknown;
  };
}
```

- Standard codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403),
  `NOT_FOUND` (404), `VALIDATION` (422), `RATE_LIMITED` (429),
  `CONFLICT` (409), `INTERNAL` (500).
- List endpoints paginate with `?limit=&cursor=` and return:

```ts
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
```

## 2. Auth & session

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/auth/:provider/start` | public | Begin OAuth (`provider` = `google`\|`github`) |
| GET | `/auth/:provider/callback` | public | OAuth redirect target; sets session |
| POST | `/auth/logout` | player | Clear session |
| POST | `/auth/link/:provider/start` | player | Link an additional SSO identity |
| GET | `/me` | player | Current user + linked identities + my portfolio id |

```ts
interface MeResponse {
  user: User;
  identities: Array<Pick<Identity, "provider" | "emailAtLink">>;
  portfolioId: string;    // v1: each user has exactly one portfolio
  csrfToken: string;      // rotated per session; send as X-CSRF-Token on mutations
}
```

Full flow detail in [05-auth](05-auth.md).

## 3. Portfolio & trading

In v1 each user has exactly one portfolio, auto-created on first sign-in
with `cash = 100_000_000` (cents). All routes scoped to a portfolio the
caller owns (or admin).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/portfolios/:id` | player | Cash, positions, current best-effort equity |
| GET | `/portfolios/:id/orders` | player | Order history (paginated) |
| GET | `/portfolios/:id/history` | player | Equity over time (from snapshots) |
| POST | `/portfolios/:id/orders` | player | Submit an order |
| POST | `/portfolios/:id/orders/:orderId/cancel` | player | Cancel (if cancellable) |

```ts
interface PortfolioView {
  portfolio: Portfolio;
  positions: Array<{
    symbol: string;
    quantity: number;
    avgCost: number;
    lastPrice: number | null;   // latest price_bar.close; null if unbackfilled
    marketValue: number | null;
  }>;
  equity: number | null;        // cash + Σ marketValue (best-effort live)
  buyingPower: number;          // == cash in v1 (no margin)
  lastSnapshotAt: string | null;// when the official ranking last refreshed
}

interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;              // "buy" | "sell"
  type: OrderType;              // "market" (only type in v1)
  quantity: number;             // > 0; fractional allowed
  idempotencyKey: string;       // client-generated
}

interface CreateOrderResponse {
  order: Order;
  fill: Fill | null;            // present if immediately filled (v1 model)
}
```

**Validation performed server-side:** caller owns the portfolio; symbol
exists in `universe_symbol` with `backfilled = true`; latest `price_bar`
for the symbol is not stale (see
[04-game-mechanics §4](04-game-mechanics.md#4-off-hours-holidays-missing-prices));
`quantity > 0`; buying power sufficient for buys; position sufficient for
sells (no shorting); idempotency-key dedupe. Failures return `422` with a
specific `code` (e.g. `SYMBOL_NOT_TRADEABLE`, `STALE_PRICE`,
`INSUFFICIENT_FUNDS`, `INSUFFICIENT_POSITION`).

> **Fill price (v1):** the most recent `price_bar.close` for the symbol.
> Because v1 refreshes prices once daily, during the day this is the prior
> trading day's close; after 16:30 ET it is today's; on Monday morning it
> is Friday's — by design (see
> [04-game-mechanics §2](04-game-mechanics.md#2-trading--fills)).

## 4. Leaderboard

A single perpetual leaderboard in v1.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/leaderboard` | public | Ranked rows from the latest snapshot |

```ts
interface LeaderboardResponse {
  takenAt: string;            // snapshot the ranking reflects
  rows: Array<{
    rank: number;
    portfolioId: string;
    displayName: string;      // user.displayName for humans; algo.name for bots
    isBot: boolean;
    equity: number;
    returnPct: number;
  }>;
  nextCursor: string | null;  // cursor for paging large boards
}
```

## 5. Market data (read-only passthrough)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/quotes?symbols=AAPL,MSFT` | player | Latest `price_bar.close` per symbol |
| GET | `/symbols` | public | The S&P 500 universe (tradeable subset) |

```ts
interface QuotesResponse {
  asOf: string;               // latest price_bar ts considered
  quotes: Record<string, { price: number | null; ts: string | null }>;
}

interface SymbolsResponse {
  items: Array<{
    symbol: string;
    backfilled: boolean;      // false → not yet tradeable
  }>;
}
```

Symbols not yet backfilled return `null` and cannot be traded.

## 6. Admin (v1)

`auth: admin` for all. v1 admin surface is minimal — the universe registry
and an ops view.

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/universe/upsert` | Add or update S&P 500 membership rows |
| POST | `/admin/universe/backfill` | Manually re-trigger backfill for a symbol |
| GET | `/admin/ops` | Operational view (EOD-update lag, market data 429s, queue depth, backfill remaining) |

```ts
interface UpsertUniverseRequest {
  symbols: string[];          // e.g. ["AAPL","MSFT",...]
}

interface OpsResponse {
  lastEodUpdateAt: string | null;   // last successful EOD price-update run
  eodUpdateLagSec: number | null;   // now - lastEodUpdateAt
  marketData429sLast24h: { massive: number };
  jobQueueDepth: number;            // currently-held worker job locks
  backfillRemaining: number;        // count of universe_symbol where backfilled = false
}
// Note: snapshots/leaderboard were dropped in the item-16 platform pivot, so
// "snapshot lag" is re-targeted at the daily EOD price-update cron.
```

## 7. WebSocket

One authenticated socket at `/ws`. Client subscribes to topics; server
pushes typed events.

```ts
type WsClientMessage =
  | { type: "subscribe"; topic: WsTopic }
  | { type: "unsubscribe"; topic: WsTopic };

type WsTopic =
  | { kind: "portfolio"; portfolioId: string }   // owner only
  | { kind: "leaderboard" }                      // v1: perpetual board
  | { kind: "quotes"; symbols: string[] };

type WsServerMessage =
  | { type: "portfolio.updated"; portfolioId: string; view: PortfolioView }
  | { type: "order.filled"; portfolioId: string; order: Order; fill: Fill }
  | { type: "leaderboard.updated"; data: LeaderboardResponse }
  | { type: "quotes.updated"; asOf: string; quotes: QuotesResponse["quotes"] }
  | { type: "error"; error: ApiError["error"] };
```

In v1, `leaderboard.updated` fires **once per day** after the EOD snapshot
completes. `portfolio.updated` and `order.filled` fire on each fill.
`quotes.updated` fires after the daily price update. v2 increases all of
these to per-snapshot cadence.

## 8. Rate limiting

- All routes: per-IP limits to absorb bot/abuse traffic (default 60 req/min).
- Auth `start` routes: tighter per-IP cap (10 req/min) — these kick off OAuth.
- Admin routes (`/admin/*`): explicit per-route cap (30 req/min).
- `429` returns `Retry-After`. Enforced via `@fastify/rate-limit` backed by
  Redis (so limits hold across api instances).
- (The order-endpoint per-user cap from the original game design is gone —
  orders were dropped in the item-16 platform pivot.)

## 9. v2+ / v3+ endpoint outlook

v2 adds **seasons + themes**:

| Method | Path | Auth | Phase | Purpose |
|---|---|---|---|---|
| GET | `/themes` | public | v2 | List active themes |
| GET | `/themes/:key` | public | v2 | Theme + its symbol list |
| GET | `/seasons` | public | v2 | List seasons (filter `?status=`) |
| GET | `/seasons/:id` | public | v2 | Season detail |
| POST | `/seasons/:id/join` | player | v2 | Create caller's portfolio in the season |
| GET | `/seasons/:id/leaderboard` | public | v2 | Per-season ranked rows |
| POST | `/admin/themes` | admin | v2 | Create theme |
| PUT | `/admin/themes/:id/symbols` | admin | v2 | Set a theme's symbol list |
| POST | `/admin/seasons` | admin | v2 | Create a season (draft) |
| POST | `/admin/seasons/:id/transition` | admin | v2 | Move status (draft→scheduled→active→…) |
| POST | `/admin/seasons/:id/bots` | admin | v2 | Seed N house bots into the season |

v3 adds **user-authored algos**:

| Method | Path | Auth | Phase | Purpose |
|---|---|---|---|---|
| GET | `/algos` | player | v3 | Caller's algos |
| POST | `/algos` | player | v3 | Create an algo definition |
| GET | `/algos/:id` | player | v3 | Algo detail |
| PATCH | `/algos/:id` | player | v3 | Update config / enable-disable |
| POST | `/seasons/:id/join-with-algo` | player | v3 | Join season driven by an algo |

The `WsTopic` shape gains a `seasonId` discriminator in v2 (the v1
`{ kind: "leaderboard" }` becomes `{ kind: "leaderboard"; seasonId?: string }`
where the absent form continues to address the v1 perpetual board for
backward compatibility, or is removed at the v2 cutover — see
[09-open-questions](09-open-questions.md)).
