# 03 — API

> Interface definitions only — **not implemented**. The public API is REST over
> HTTPS with JSON bodies; live updates use WebSocket. Types reuse the entities in
> [02-data-model](02-data-model.md). The contract source-of-truth format
> (OpenAPI vs Protobuf) is a **TODO** — see [09-open-questions](09-open-questions.md).

## 1. Conventions

- Base path: `/api/v1`.
- Auth: session cookie (HTTP-only, secure) established via SSO; see
  [05-auth](05-auth.md). Endpoints below note `auth: player|admin|public`.
- All timestamps ISO-8601 UTC. All money in integer **cents**.
- Errors use a consistent envelope:

```ts
interface ApiError {
  error: {
    code: string;        // machine-readable, e.g. "SYMBOL_NOT_IN_THEME"
    message: string;     // human-readable
    details?: unknown;   // optional structured context
  };
}
```

- Standard codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
  `VALIDATION` (422), `RATE_LIMITED` (429), `CONFLICT` (409), `INTERNAL` (500).
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
| GET | `/me` | player | Current user + linked identities |

```ts
interface MeResponse {
  user: User;
  identities: Array<Pick<Identity, "provider" | "emailAtLink">>;
}
```

Full flow detail in [05-auth](05-auth.md).

## 3. Themes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/themes` | public | List active themes |
| GET | `/themes/:key` | public | Theme + its symbol list |

```ts
interface ThemeDetail {
  theme: Theme;
  symbols: string[];
}
```

## 4. Seasons

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/seasons` | public | List seasons (filter `?status=`) |
| GET | `/seasons/:id` | public | Season detail |
| POST | `/seasons/:id/join` | player | Create caller's portfolio in the season |
| GET | `/seasons/:id/leaderboard` | public | Ranked rows from latest snapshot |

```ts
interface SeasonDetail {
  season: Season;
  theme: Pick<Theme, "key" | "name">;
  playerCount: number;
  joined: boolean;            // is the caller already in?
}

interface JoinSeasonResponse {
  portfolio: Portfolio;
}

interface LeaderboardResponse {
  takenAt: string;            // snapshot the ranking reflects
  rows: Array<{
    rank: number;
    portfolioId: string;
    displayName: string;      // user or bot name
    isBot: boolean;
    equity: number;
    returnPct: number;
  }>;
  page: Page<never>["nextCursor"]; // cursor for paging large boards
}
```

> Join is rejected if season status is not `scheduled`/`active`, or if a join
> policy (one portfolio per user) is violated. See
> [04-game-mechanics](04-game-mechanics.md).

## 5. Portfolio & trading

All scoped to a portfolio the caller owns (or admin).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/portfolios/:id` | player | Cash, positions, current equity (cached price) |
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
    lastPrice: number | null;   // from quote cache; null if unknown
    marketValue: number | null;
  }>;
  equity: number | null;        // cash + Σ marketValue (best-effort live)
  buyingPower: number;          // == cash in v1 (no margin)
}

interface CreateOrderRequest {
  symbol: string;
  side: OrderSide;              // "buy" | "sell"
  type: OrderType;              // "market" (only type in v1)
  quantity: number;            // > 0; fractional allowed
  idempotencyKey: string;       // client-generated; dedupes retries
}

interface CreateOrderResponse {
  order: Order;
  fill: Fill | null;            // present if immediately filled (v1 model)
}
```

**Validation performed server-side:** season active; symbol ∈ theme; `quantity > 0`;
buying power sufficient for buys; position sufficient for sells (no shorting);
idempotency-key dedupe. Failures return `422` with a specific `code`.

## 6. Algos / bots (player-facing)

Players can register algos and attach one to a season as a portfolio driver.
House-bot creation is admin-only (§8). Execution model: see
[07-bots-and-algos](07-bots-and-algos.md).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/algos` | player | Caller's algos |
| POST | `/algos` | player | Create an algo definition |
| GET | `/algos/:id` | player | Algo detail |
| PATCH | `/algos/:id` | player | Update config / enable-disable |
| POST | `/seasons/:id/join-with-algo` | player | Join season driven by an algo |

```ts
interface CreateAlgoRequest {
  name: string;
  strategyType: string;        // must be a registered, allowed type
  config: Record<string, unknown>;  // validated against the type's schema
}
```

> **Security note:** `strategyType` must be one of the server's registered
> strategy types. v1 does **not** accept arbitrary user code via this API. See
> [07-bots-and-algos](07-bots-and-algos.md#execution-model).

## 7. Market data (read-only passthrough)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/quotes?symbols=AAPL,MSFT` | player | Latest cached prices (never hits Alpaca synchronously) |

```ts
interface QuotesResponse {
  asOf: string;               // cache timestamp
  quotes: Record<string, { price: number | null }>;  // cents; null if unknown
}
```

Symbols not in any active theme may return `null` (we don't poll them).

## 8. Admin

`auth: admin` for all. Used to run the game and seed leaderboards with house bots.

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/themes` | Create theme |
| PUT | `/admin/themes/:id/symbols` | Set a theme's symbol list |
| POST | `/admin/seasons` | Create a season (draft) |
| POST | `/admin/seasons/:id/transition` | Move status (draft→scheduled→active→…) |
| POST | `/admin/seasons/:id/bots` | Seed N house bots into the season |
| GET | `/admin/seasons/:id/ops` | Operational view (snapshot lag, Alpaca errors) |

```ts
interface SeedBotsRequest {
  bots: Array<{
    name: string;             // e.g. "lava lamp #3"
    strategyType: string;     // "random" | "mixed" | "buy_and_hold" | ...
    config?: Record<string, unknown>;
    count?: number;           // shorthand to create several of one kind
  }>;
}

interface TransitionSeasonRequest {
  to: SeasonStatus;           // server validates legal transitions
}
```

## 9. WebSocket

One authenticated socket at `/ws`. Client subscribes to topics; server pushes
typed events. Used for live portfolio/leaderboard updates without polling.

```ts
type WsClientMessage =
  | { type: "subscribe"; topic: WsTopic }
  | { type: "unsubscribe"; topic: WsTopic };

type WsTopic =
  | { kind: "portfolio"; portfolioId: string }   // owner only
  | { kind: "leaderboard"; seasonId: string }
  | { kind: "quotes"; symbols: string[] };

type WsServerMessage =
  | { type: "portfolio.updated"; portfolioId: string; view: PortfolioView }
  | { type: "order.filled"; portfolioId: string; order: Order; fill: Fill }
  | { type: "leaderboard.updated"; seasonId: string; data: LeaderboardResponse }
  | { type: "quotes.updated"; asOf: string; quotes: QuotesResponse["quotes"] }
  | { type: "error"; error: ApiError["error"] };
```

Push cadence is tied to the quote-poll and snapshot cadences in
[01-architecture](01-architecture.md); the socket does not create new Alpaca load.

## 10. Rate limiting

- Order/algo endpoints: stricter per-user limits (protects fairness + Alpaca).
- `429` returns `Retry-After`. Limits enforced via Redis counters.
- Specific numeric limits: **TODO** ([09-open-questions](09-open-questions.md)).
