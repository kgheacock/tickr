# 04 — Game Mechanics

This doc defines the rules of play: seasons, themes, capital, trading, valuation,
and the leaderboard. Where a number isn't yet decided it is marked **TODO**.

## 1. Seasons

A **season** is one time-boxed competition: a single theme, a single leaderboard,
a fixed start/end. Players join, trade for the duration, and are ranked.

### 1.1 Lifecycle

```
draft ──▶ scheduled ──▶ active ──▶ settling ──▶ closed
  │            │            │
  └─ admin edits freely     └─ trading allowed only while active
```

| Status | Meaning | Trading? | Joining? |
|---|---|---|---|
| `draft` | Admin building it | no | no |
| `scheduled` | Locked config, future start | no | yes (pre-register) |
| `active` | Live | yes | yes, until 25% of duration elapsed |
| `settling` | Ended; final snapshot/ranking computing | no | no |
| `closed` | Final results frozen | no | no |

### 1.2 Length

**Decision: 1 month default.** The admin sets `startsAt` / `endsAt` per season,
so length can vary; the default when creating a new season is 30 days. Monthly
balances strategy depth against engagement — long enough to reward skill over
luck, short enough to keep attention. Shorter (2-week) is a valid experiment for
future seasons.

| Option | Pros | Cons |
|---|---|---|
| 1 week | Fast turnover, frequent winners | Noisy; luck-dominated |
| 2 weeks | Balance of skill/luck | — |
| **1 month** ✓ | Strategy matters, fits a "season" feel | Slower engagement loop |
| Quarter | Mirrors real reporting cadence | Long; attrition risk |

### 1.3 Trading windows vs. market hours

**Decision: accept orders 24/7; fill at last cached price.** Off-hours orders
fill at the most recent close price. This keeps the UI simple (no "market closed"
rejection states) while preserving fairness — everyone in a window fills at the
same cached price. This is a game, not a brokerage.

## 2. Themes

A theme is the **constrained tradeable universe** for a season. Its purpose is
twofold: (1) make seasons varied and fair (everyone trades the same finite set),
and (2) **bound Alpaca API load** — we only poll symbols belonging to active
seasons' themes.

Examples (admin-curated, stored as data — see [02-data-model](02-data-model.md)):

| Theme key | Roughly | Why it's fun |
|---|---|---|
| `big-7` | The mega-cap tech names | Tight, high-variance, easy to follow |
| `top-50` | ~50 large caps | More breadth, more diversification skill |
| `energy` | Energy-sector names | Sector dynamics, correlated moves |

Rules:

- A season's orders are restricted to its theme's symbols at submission time.
- Symbol membership is a snapshot at season creation (changing a theme mid-season
  is disallowed for active seasons — **TODO** to confirm; recommended).
- The union of active themes' symbols is small, so one poll cadence serves all
  active seasons. See [01-architecture](01-architecture.md#21-market-data-ingestion).

## 3. Starting capital & buying power

- Every player begins each season with **exactly** the season's
  `startingCapital`, default **$1,000,000** (`100_000_000` cents).
- **Buying power = cash** in v1. No margin, no leverage, no shorting.
- Buys require `cash >= quantity × price (+ fees if any)`. Sells require holding
  the quantity. These are hard invariants (see
  [02-data-model](02-data-model.md#4-invariants)).

**Decision: zero fees in v1.** Results stay legible; return % maps directly to
trading decisions. A configurable fee can be added later as a season parameter
(`season.commissionCents`) to discourage churn without re-architecting.

## 4. Orders & fills

v1 supports **market orders only**.

### 4.1 Fill model (v1)

Proposed default: **immediate fill at the latest cached price** for the symbol.

- Pros: simple, deterministic within a quote window, no resting-order machinery.
- Cons: ignores slippage, spread, and intrabar movement.

Deferred (post-v1): limit orders, stop orders, partial fills, slippage modeling,
spread-aware fills. Modeled as future `OrderType`s; the schema reserves room.

> **Fairness consideration:** Because everyone fills at the same cached price
> within a poll window, no player gets a latency edge. This is intentional and a
> reason to *prefer* cached-price fills over chasing live ticks.

### 4.2 Rejections

Orders are rejected (not silently dropped) with a specific `code` when: season not
active, symbol not in theme, insufficient buying power / position, non-positive
quantity, or duplicate idempotency key resolving to a prior rejection.

## 5. Valuation

A **valuation snapshot** marks every active portfolio to market on a cadence
(`season.snapshotIntervalSec`, default **5 min / 300 s**).

```
equity = cash + Σ over positions ( quantity × latest_price(symbol) )
```

Snapshots are immutable rows (see [02-data-model](02-data-model.md#28-valuation_snapshot)).
The **leaderboard ranks on the latest snapshot's equity**, not on live quotes.
This makes rankings stable, reproducible, and fair (everyone marked at the same
prices/time).

### 5.1 Final settlement

On `endsAt`, the season moves to `settling`. A final snapshot is taken (TODO:
based on market close of the end date vs. exact `endsAt` instant), the final
leaderboard is computed, and the season moves to `closed`. Closed results are
frozen.

## 6. Leaderboard

- **Metric:** total equity (cash + positions value) at the latest snapshot.
- **Display also shows:** return % vs. starting capital.
- **Ordering:** equity descending.
- **Tie-breaking:** ties share a rank; stable secondary sort by `portfolioId`
  (UUID, deterministic). Risk-adjusted tie-breaking is a future option once
  the Sharpe metric is well-established.
- **Bots are ranked alongside humans** and clearly flagged (`isBot: true`). They
  give humans a baseline and keep early/empty seasons lively (see §7 and
  [07-bots-and-algos](07-bots-and-algos.md)).

### 6.1 Anti-abuse considerations (TODO to flesh out)

- One human, one manual portfolio per season (see uniqueness note in
  [02-data-model](02-data-model.md#25-portfolio)).
- Rate limits on orders to prevent spam and protect Alpaca budget
  ([03-api](03-api.md#10-rate-limiting)).
- Because all players share the same theme, capital, and fill prices, the surface
  for "unfair edge" is small by construction.

## 7. Bots in the game

The admin seeds each season with **house bots** so the leaderboard is populated
immediately. House bots are ordinary portfolios driven by an `algo` rather than a
human. Examples the prompt calls out:

- **"lava lamp"** — random buys/sells within the theme (a chaos baseline).
- **"mixed"** — a blend of simple strategies.
- Plus simple references like **buy-and-hold** the whole theme (an index-like
  baseline that's genuinely hard to beat).

Behavior, scheduling, and the strategy registry are specified in
[07-bots-and-algos](07-bots-and-algos.md). Players may also enter their own
**algorithmic** strategies, competing in the same season under the same rules.

## 8. Open mechanics decisions

Consolidated in [09-open-questions](09-open-questions.md):

1. Season length default.
2. Trading window (24/7 vs market hours) & off-hours fill price.
3. Fees/commissions (default zero?).
4. Snapshot cadence default.
5. Tie-breaking rule.
6. Late-join policy for active seasons.
7. Whether shorting/limit orders ever enter scope.
