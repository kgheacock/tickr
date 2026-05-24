# 02 — Data Model

> Schemas are **defined, not implemented**. Types below are language-neutral.
> SQL is illustrative (Postgres dialect) to pin down relationships, constraints,
> and indexes — not a migration. Monetary values are integer **cents** (or a
> `NUMERIC` with fixed scale) to avoid float drift; quantities support fractional
> shares as `NUMERIC`.

## 1. Entity-relationship summary

```
user 1───∞ identity          (one user, many linked SSO identities)
user 1───∞ portfolio         (one per season the user joins)
user 1───∞ algo              (user-authored strategies; house algos owned by admin)

season 1───∞ portfolio
season 1───1 theme           (theme is a named symbol set; see note)
season 1───∞ valuation_snapshot
season 1───∞ leaderboard_row (per snapshot)

portfolio 1───∞ position
portfolio 1───∞ order
order     1───∞ fill
portfolio 1───∞ valuation_snapshot (a portfolio's marks over time)

theme  1───∞ theme_symbol
```

## 2. Core entities

### 2.1 `user`

The human (or the admin) behind one or more SSO identities.

```ts
interface User {
  id: string;            // UUID
  displayName: string;   // shown on leaderboard
  email: string | null;  // primary; may be null if provider withholds
  role: "player" | "admin";
  createdAt: string;     // ISO-8601 UTC
  // No password field — auth is SSO only (see 05-auth.md).
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
  providerSubject: string;   // stable subject/sub from the IdP
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

### 2.3 `theme` and `theme_symbol`

A theme is a named, curated symbol universe. Seasons reference a theme. Keeping
themes as data (not code) lets the admin add "Energy", "Big 7", etc. without a
deploy, and bounds Alpaca load.

```ts
interface Theme {
  id: string;
  key: string;          // stable slug e.g. "big-7", "top-50", "energy"
  name: string;         // human label
  description: string;
  active: boolean;      // available for new seasons
}

interface ThemeSymbol {
  themeId: string;
  symbol: string;       // e.g. "AAPL"
  // Optional display metadata; pricing comes from Alpaca at runtime.
}
```

```sql
CREATE TABLE theme (
  id          UUID PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE theme_symbol (
  theme_id UUID NOT NULL REFERENCES theme(id) ON DELETE CASCADE,
  symbol   TEXT NOT NULL,
  PRIMARY KEY (theme_id, symbol)
);
```

> **Note:** A symbol may appear in multiple themes. The set of symbols the worker
> polls is `SELECT DISTINCT symbol FROM theme_symbol JOIN season ... WHERE season
> active`. See [01-architecture](01-architecture.md#21-market-data-ingestion).

### 2.4 `season`

```ts
type SeasonStatus = "draft" | "scheduled" | "active" | "settling" | "closed";

interface Season {
  id: string;
  name: string;
  themeId: string;
  status: SeasonStatus;
  startsAt: string;          // ISO-8601 UTC
  endsAt: string;            // ISO-8601 UTC — length is TODO (see 04)
  startingCapital: number;   // cents; default 100_000_000 (= $1,000,000)
  snapshotIntervalSec: number; // valuation cadence
  createdBy: string;         // admin user id
  createdAt: string;
}
```

```sql
CREATE TABLE season (
  id                    UUID PRIMARY KEY,
  name                  TEXT NOT NULL,
  theme_id              UUID NOT NULL REFERENCES theme(id),
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN
                            ('draft','scheduled','active','settling','closed')),
  starts_at             TIMESTAMPTZ NOT NULL,
  ends_at               TIMESTAMPTZ NOT NULL,
  starting_capital      BIGINT NOT NULL DEFAULT 100000000,  -- cents
  snapshot_interval_sec INTEGER NOT NULL DEFAULT 300,
  created_by            UUID NOT NULL REFERENCES app_user(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
```

### 2.5 `portfolio`

One per (user, season). Holds cash; positions hang off it.

```ts
interface Portfolio {
  id: string;
  seasonId: string;
  userId: string;            // owner (human OR the admin owning a house bot)
  algoId: string | null;     // set if this portfolio is driven by an algo/bot
  cash: number;              // cents available
  joinedAt: string;
}
```

```sql
CREATE TABLE portfolio (
  id         UUID PRIMARY KEY,
  season_id  UUID NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES app_user(id),
  algo_id    UUID REFERENCES algo(id),
  cash       BIGINT NOT NULL,            -- cents; seeded = season.starting_capital
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_id, user_id, algo_id)   -- see note on uniqueness below
);
```

> **Uniqueness note / TODO:** Is a human allowed both a manual portfolio *and*
> one or more algo portfolios in the same season? The `UNIQUE` above permits one
> manual (`algo_id IS NULL`) plus distinct algo portfolios. Confirm in
> [09-open-questions](09-open-questions.md).

### 2.6 `position`

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
  symbol       TEXT NOT NULL,
  quantity     NUMERIC(20,8) NOT NULL DEFAULT 0,
  avg_cost     BIGINT NOT NULL DEFAULT 0,   -- cents/share
  PRIMARY KEY (portfolio_id, symbol),
  CHECK (quantity >= 0)                     -- no shorting in v1 (TODO)
);
```

### 2.7 `order` and `fill`

Orders are immutable instructions; fills are immutable executions. Both are
append-only for auditability.

```ts
type OrderSide = "buy" | "sell";
type OrderType = "market";                 // limit/stop deferred — TODO
type OrderStatus = "accepted" | "rejected" | "filled" | "cancelled";

interface Order {
  id: string;
  portfolioId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: number;          // requested
  status: OrderStatus;
  rejectReason: string | null;
  idempotencyKey: string;    // client-supplied; dedupes retries
  source: "human" | "algo";
  createdAt: string;
}

interface Fill {
  id: string;
  orderId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;          // filled (may be < ordered if partials enabled)
  price: number;             // cents/share at fill
  filledAt: string;
}
```

```sql
CREATE TABLE trade_order (
  id              UUID PRIMARY KEY,
  portfolio_id    UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL,
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

### 2.8 `valuation_snapshot`

Periodic mark-to-market per portfolio. The source of truth for the leaderboard.

```ts
interface ValuationSnapshot {
  id: string;
  seasonId: string;
  portfolioId: string;
  takenAt: string;           // snapshot time
  cash: number;              // cents
  positionsValue: number;    // cents, Σ qty×price
  equity: number;            // cash + positionsValue
}
```

```sql
CREATE TABLE valuation_snapshot (
  id              UUID PRIMARY KEY,
  season_id       UUID NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  portfolio_id    UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  taken_at        TIMESTAMPTZ NOT NULL,
  cash            BIGINT NOT NULL,
  positions_value BIGINT NOT NULL,
  equity          BIGINT NOT NULL,
  UNIQUE (portfolio_id, taken_at)
);
CREATE INDEX ON valuation_snapshot (season_id, taken_at);
```

### 2.9 `leaderboard_row`

Materialized ranking for a given snapshot moment. Read-heavy; cached in Redis.

```ts
interface LeaderboardRow {
  seasonId: string;
  takenAt: string;           // which snapshot this ranking reflects
  portfolioId: string;
  rank: number;
  equity: number;            // cents
  returnPct: number;         // vs starting capital, basis points or float
}
```

```sql
CREATE TABLE leaderboard_row (
  season_id    UUID NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  taken_at     TIMESTAMPTZ NOT NULL,
  portfolio_id UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  rank         INTEGER NOT NULL,
  equity       BIGINT NOT NULL,
  return_pct   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (season_id, taken_at, portfolio_id)
);
CREATE INDEX ON leaderboard_row (season_id, taken_at, rank);
```

### 2.10 `algo`

A strategy definition. House bots (random "lava lamp", "mixed", etc.) and
user-authored algos share this table; `kind` distinguishes them. Execution detail
lives in [07-bots-and-algos](07-bots-and-algos.md).

```ts
type AlgoKind = "house" | "user";

interface Algo {
  id: string;
  ownerUserId: string;       // admin for house bots
  kind: AlgoKind;
  name: string;              // e.g. "lava lamp", "momentum-v1"
  strategyType: string;      // e.g. "random", "buy_and_hold", "declarative"
  config: Record<string, unknown>; // strategy params (validated per type)
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

## 3. Derived vs. stored

| Data | Stored? | Why |
|---|---|---|
| `position` | Materialized | Fast reads; rebuildable from fills |
| `portfolio.cash` | Materialized | Authoritative running balance, updated per fill in a txn |
| `valuation_snapshot` | Stored | Immutable history; basis for ranking |
| `leaderboard_row` | Stored + cached | Reproducible from snapshots; cached for read load |
| Live quote | **Not** in Postgres | Redis cache only; periodic price points persisted for history |

## 4. Invariants

1. A portfolio's `cash` and `position` rows are only mutated inside the same DB
   transaction that records the `fill`.
2. `cash >= 0` always (no margin in v1).
3. An order's `symbol` must be in its season's theme at submission time.
4. Snapshots and fills are append-only; corrections happen via new rows, never
   in-place edits.
5. Leaderboard ranking for a `taken_at` is a pure function of the snapshots at
   that `taken_at` → reproducible and auditable.

## 5. Open schema TODOs

- Fractional shares precision (`NUMERIC(20,8)` is a placeholder).
- Shorting / margin (currently disallowed by `CHECK` constraints).
- Limit/stop order types (only `market` modeled now).
- Multi-portfolio-per-user-per-season policy (see 2.5 note).
- Contract/source-of-truth format for shared types (OpenAPI vs Protobuf).

See [09-open-questions](09-open-questions.md) for the consolidated list.
