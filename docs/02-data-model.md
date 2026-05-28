# 02 — Data Model

> This doc describes **v1 schema in the body** and previews v2+ extensions in
> §5. Schemas are **defined, not implemented**. Types below are
> language-neutral. SQL is illustrative (Postgres dialect) to pin down
> relationships, constraints, and indexes — not a migration. Monetary values
> are integer **cents** (or a `NUMERIC` with fixed scale) to avoid float
> drift; quantities support fractional shares as `NUMERIC(20,8)`.

## 1. v1 entity-relationship summary

```
user 1───∞ identity            (one user, many linked SSO identities)
user 1───1 portfolio           (v1: one perpetual portfolio per user)
                                 v2+ relaxes to one per (user, season)

portfolio 1───∞ position
portfolio 1───∞ order
order     1───∞ fill
portfolio 1───∞ valuation_snapshot

algo (single row in v1: the "index" buy-and-hold bot)
  └──▶ has its own portfolio, just like a human

universe_symbol               (S&P 500 registry; backfill-state gate)
price_bar                     (TimescaleDB hypertable; sole source of pricing)
valuation_snapshot ───∞ leaderboard_row
```

There is **no** `theme`, `theme_symbol`, `season`, or `watch_list` in v1 —
those land in v2 (see §5).

## 2. Core entities (v1)

### 2.1 `app_user`

The human (or the admin) behind one or more SSO identities.

```ts
interface User {
  id: string;            // UUID
  displayName: string;   // shown on leaderboard
  email: string | null;  // primary; may be null if provider withholds
  role: "player" | "admin";
  createdAt: string;     // ISO-8601 UTC
}
```

```sql
CREATE TABLE app_user (
  id           UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  email        TEXT,
  role         TEXT NOT NULL DEFAULT 'player'
                 CHECK (role IN ('player','admin')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.2 `identity`

A federated login linked to a user. Lets one user link both Google and GitHub.

```ts
interface Identity {
  id: string;
  userId: string;
  provider: "google" | "github";
  providerSubject: string;
  emailAtLink: string | null;
  createdAt: string;
}
```

```sql
CREATE TABLE identity (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('google','github')),
  provider_subject TEXT NOT NULL,
  email_at_link    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);
```

### 2.3 `portfolio`

One per user in v1 (perpetual; no season). Holds cash; positions hang off it.

```ts
interface Portfolio {
  id: string;
  userId: string;            // owner (human OR the admin owning the index bot)
  algoId: string | null;     // null for humans; set for the index bot
  cash: number;              // cents available
  joinedAt: string;
}
```

```sql
CREATE TABLE portfolio (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES app_user(id),
  algo_id    UUID REFERENCES algo(id),
  cash       BIGINT NOT NULL,                -- cents; seeded = 100_000_000
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one human portfolio per user (algo_id IS NULL).
-- A plain UNIQUE (user_id, algo_id) won't enforce this because NULL ≠ NULL
-- for unique constraints in Postgres — two (U, NULL) rows would both be
-- allowed. Use a partial unique index instead.
CREATE UNIQUE INDEX portfolio_one_human_per_user
  ON portfolio (user_id) WHERE algo_id IS NULL;

-- One portfolio per (user, algo) for users running algos.
CREATE UNIQUE INDEX portfolio_one_per_user_algo
  ON portfolio (user_id, algo_id) WHERE algo_id IS NOT NULL;
```

> In v2, `season_id` is added and the same NULL-trap applies. The v2
> uniqueness becomes a pair of partial indexes scoped by `season_id`
> (`(season_id, user_id) WHERE algo_id IS NULL` and
> `(season_id, user_id, algo_id) WHERE algo_id IS NOT NULL`). Postgres 15+
> alternative: `UNIQUE NULLS NOT DISTINCT (season_id, user_id, algo_id)`.

### 2.4 `position`

Current holding of one symbol in one portfolio. Derived from fills but
materialized for fast reads.

```ts
interface Position {
  portfolioId: string;
  symbol: string;
  quantity: number;          // NUMERIC; fractional allowed
  avgCost: number;           // cents per share, cost basis
}
```

```sql
CREATE TABLE position (
  portfolio_id UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL REFERENCES universe_symbol(symbol),
  quantity     NUMERIC(20,8) NOT NULL DEFAULT 0,
  avg_cost     BIGINT NOT NULL DEFAULT 0,    -- cents/share
  PRIMARY KEY (portfolio_id, symbol),
  CHECK (quantity >= 0)                      -- no shorting in v1
);
```

### 2.5 `trade_order` and `fill`

Orders are immutable instructions; fills are immutable executions. Both are
append-only for auditability.

```ts
type OrderSide = "buy" | "sell";
type OrderType = "market";                   // limit/stop deferred
type OrderStatus = "accepted" | "rejected" | "filled" | "cancelled";

interface Order {
  id: string;
  portfolioId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;
  status: OrderStatus;
  rejectReason: string | null;
  idempotencyKey: string;
  source: "human" | "algo";
  createdAt: string;
}

interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  price: number;             // cents/share at fill
  filledAt: string;
}
```

```sql
CREATE TABLE trade_order (
  id              UUID PRIMARY KEY,
  portfolio_id    UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL REFERENCES universe_symbol(symbol),
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type            TEXT NOT NULL DEFAULT 'market' CHECK (type IN ('market')),
  quantity        NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
  status          TEXT NOT NULL
                    CHECK (status IN ('accepted','rejected','filled','cancelled')),
  reject_reason   TEXT,
  idempotency_key TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('human','algo')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, idempotency_key)
);

CREATE TABLE fill (
  id         UUID PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES trade_order(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('buy','sell')),
  quantity   NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
  price      BIGINT NOT NULL,            -- cents/share
  filled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.6 `valuation_snapshot`

Daily mark-to-market per portfolio. The source of truth for the leaderboard.

```ts
interface ValuationSnapshot {
  id: string;
  portfolioId: string;
  takenAt: string;           // snapshot time (UTC; EOD job stamps this)
  cash: number;              // cents
  positionsValue: number;    // cents, Σ qty×price
  equity: number;            // cash + positionsValue
}
```

```sql
CREATE TABLE valuation_snapshot (
  id              UUID PRIMARY KEY,
  portfolio_id    UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  taken_at        TIMESTAMPTZ NOT NULL,
  cash            BIGINT NOT NULL,
  positions_value BIGINT NOT NULL,
  equity          BIGINT NOT NULL,
  UNIQUE (portfolio_id, taken_at)
);
CREATE INDEX ON valuation_snapshot (taken_at);
```

> `season_id` is intentionally absent in v1; v2 adds it (nullable initially,
> backfilled to the v2 "legacy" season, then `NOT NULL`).

### 2.7 `leaderboard_row`

Materialized ranking for a given snapshot moment. Read-heavy; cached in Redis.

```ts
interface LeaderboardRow {
  takenAt: string;           // which snapshot this ranking reflects
  portfolioId: string;
  rank: number;
  equity: number;            // cents
  returnPct: number;         // vs starting capital
}
```

```sql
CREATE TABLE leaderboard_row (
  taken_at     TIMESTAMPTZ NOT NULL,
  portfolio_id UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  rank         INTEGER NOT NULL,
  equity       BIGINT NOT NULL,
  return_pct   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (taken_at, portfolio_id)
);
CREATE INDEX ON leaderboard_row (taken_at, rank);
```

### 2.8 `algo`

A strategy definition. v1 has exactly **one row**: the built-in `index`
buy-and-hold bot owned by the admin. v2 introduces the full strategy
registry; v3 introduces user-authored algos.

```ts
type AlgoKind = "house" | "user";          // only "house" in v1

interface Algo {
  id: string;
  ownerUserId: string;       // admin for house bots
  kind: AlgoKind;
  name: string;              // v1: "index"
  strategyType: string;      // v1: "buy_and_hold"
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
}
```

```sql
CREATE TABLE algo (
  id            UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  kind          TEXT NOT NULL CHECK (kind IN ('house','user')),
  name          TEXT NOT NULL,
  strategy_type TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 2.9 `universe_symbol`

The S&P 500 registry: the allowed set of symbols that may ever be traded.
**Admin-managed** — the admin upserts rows when the index composition
changes (~30–50 changes/year).

Backfill state lives here because it is a property of the *data corpus*, not
of any particular game state. A symbol is only backfilled once.

**A symbol is not tradeable until `backfilled = true`.**

```ts
interface UniverseSymbol {
  symbol: string;          // e.g. "AAPL" — primary key
  addedAt: string;
  removedAt: string | null;
  backfilled: boolean;
  backfilledAt: string | null;
}
```

```sql
CREATE TABLE universe_symbol (
  symbol        TEXT        PRIMARY KEY,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  backfilled    BOOLEAN     NOT NULL DEFAULT false,
  backfilled_at TIMESTAMPTZ
);
CREATE INDEX ON universe_symbol (backfilled) WHERE backfilled = false;
```

In v1 the worker's bootstrap-backfill job iterates over rows where
`backfilled = false` and marks each `true` on completion (see
[01-architecture §2.1](01-architecture.md#21-market-data-ingestion-rest-only)).

### 2.10 `price_bar` (TimescaleDB)

OHLCV bars for S&P 500 symbols. Written by the worker's bootstrap backfill
(5 years of 5-min bars per symbol) and the daily price update (one
end-of-day bar per symbol per day). **This is the sole source of price
truth for the game** — order fills, valuation snapshots, and the bot
seeding all read from here.

```ts
interface PriceBar {
  symbol: string;
  ts: string;         // ISO-8601 UTC, bar open time
  open: number;       // cents
  high: number;       // cents
  low: number;        // cents
  close: number;      // cents
  volume: number | null;
}
```

```sql
-- Requires TimescaleDB extension enabled on the database.
CREATE TABLE price_bar (
  symbol TEXT        NOT NULL REFERENCES universe_symbol(symbol),
  ts     TIMESTAMPTZ NOT NULL,
  open   BIGINT      NOT NULL,
  high   BIGINT      NOT NULL,
  low    BIGINT      NOT NULL,
  close  BIGINT      NOT NULL,
  volume NUMERIC(20,8),
  PRIMARY KEY (symbol, ts)
);
SELECT create_hypertable('price_bar', 'ts');

-- Compress bars older than 7 days; segment by symbol for query locality.
ALTER TABLE price_bar SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol'
);
SELECT add_compression_policy('price_bar', INTERVAL '7 days');
```

> TimescaleDB partitions the hypertable by time automatically. Queries of
> the form `WHERE symbol = $1 AND ts BETWEEN $2 AND $3` are the hot path for
> portfolio history charts (v1) and future backtesting replay.

## 3. Derived vs. stored

| Data | Stored? | Why |
|---|---|---|
| `position` | Materialized | Fast reads; rebuildable from fills |
| `portfolio.cash` | Materialized | Authoritative running balance, updated per fill in a txn |
| `valuation_snapshot` | Stored | Immutable history; basis for ranking |
| `leaderboard_row` | Stored + cached | Reproducible from snapshots; cached for read load |
| OHLCV history + latest price | `price_bar` hypertable | Backfilled once + appended daily; compressed after 7 days; sole source of pricing |

## 4. Invariants

1. A portfolio's `cash` and `position` rows are only mutated inside the same
   DB transaction that records the `fill`.
2. `cash >= 0` always (no margin in v1).
3. An order's `symbol` must reference a `universe_symbol` row with
   `backfilled = true`.
4. Snapshots and fills are append-only; corrections happen via new rows,
   never in-place edits.
5. Leaderboard ranking for a `taken_at` is a pure function of the snapshots
   at that `taken_at` → reproducible and auditable.

## 5. v2+ schema outlook

v2 introduces three new tables and one column addition. All changes are
**additive** — no v1 column or table is dropped or restructured.

| Change | What |
|---|---|
| **Add** `season` | Bounded competition (`starts_at`, `ends_at`, `status`, `starting_capital`, `snapshot_interval_sec`). |
| **Add** `theme` + `theme_symbol` | Curated symbol universe per season. `theme_symbol.symbol` references `universe_symbol(symbol)`. |
| **Add column** `portfolio.season_id` | Nullable in the v2 migration; backfilled to the "legacy" v2 season for existing v1 portfolios; then `NOT NULL`. New uniqueness: two partial indexes (`(season_id, user_id) WHERE algo_id IS NULL` and `(season_id, user_id, algo_id) WHERE algo_id IS NOT NULL`) or `UNIQUE NULLS NOT DISTINCT (season_id, user_id, algo_id)` on PG 15+. |
| **Add column** `valuation_snapshot.season_id` and `leaderboard_row.season_id` | Same migration pattern. |
| **Add view** `watch_list` | `SELECT DISTINCT ts.symbol FROM theme_symbol ts JOIN season s ON s.theme_id = ts.theme_id WHERE s.status = 'active'`. |
| **Expand** `algo` rows | Multiple house bots seeded per season via the registry (`random`, `buy_and_hold`, `mixed`, `momentum`, `mean_reversion`, `cash_drip`). Schema unchanged. |

v3 adds no new tables — user-authored algos use the existing `algo` table
with `kind = 'user'` and per-user cap enforced at the API layer.

## 6. Open schema items

Consolidated in [09-open-questions](09-open-questions.md).

- Confirm `NUMERIC(20,8)` for fractional shares (placeholder).
- Confirm migration shape for `season_id` (nullable → backfill → NOT NULL).
- Confirm contract source-of-truth across a polyglot future
  (OpenAPI + JSON for the public API; `@tickr/shared-types` for internal).
