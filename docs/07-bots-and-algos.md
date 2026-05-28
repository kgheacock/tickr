# 07 — Bots & Algorithmic Strategies

> **Phases:** this doc describes the **v2+ design**. In v1 there is exactly
> one built-in bot — `index`, a buy-and-hold of an equally-weighted S&P 500
> basket, seeded once at system bootstrap and never trading again (see
> [04-game-mechanics §1.2](04-game-mechanics.md#12-the-index-bot)). The
> strategy registry below (§2) and the bot-runner cycle (§1) are **v2+**.
> User-authored algos (§1.2-on referenced as "user algos") are **v3+**.
> The order-API single-source-of-truth validation (§1.1) applies in all
> phases.

Two kinds of non-human players share one mechanism:

- **House bots** — admin-owned, used to seed and populate leaderboards (the
  prompt's "lava lamp", "mixed", etc.).
- **User algos** — player-authored algorithmic strategies competing for real on
  the leaderboard.

Both are `algo` rows ([02-data-model §2.8](02-data-model.md#28-algo)) driving a
`portfolio`, and both place orders through the **same internal order pathway**
humans use — so they're subject to identical rules (theme, capital, buying power,
validation). No special-casing in the trade engine.

## 1. Execution model

Strategies run in the **bot runner** ([01-architecture](01-architecture.md)), on a
schedule aligned to the quote/snapshot cadence — *not* on every tick. This keeps
Finnhub load bounded and ranking fair.

```
Bot runner (each cycle, e.g. each snapshot interval):
  for each enabled algo attached to an active season:
    ctx = build read-only context:
          { cash, positions, themeSymbols, latestPrices, clock }
    decisions = strategy.decide(ctx)        # pure: returns intended orders
    for each decision:
      submit order via internal order API   # same validation as humans
```

### 1.1 v1: declarative / registered strategies only

v1 does **not** execute arbitrary user-supplied code. Instead, the server ships a
registry of **strategy types**; an algo picks a type and supplies validated
`config`. This sidesteps the biggest risk (running untrusted code on the VPS) and
still allows expressive, parameterized strategies.

```ts
// A strategy is a pure decision function over a read-only context.
interface StrategyContext {
  seasonId: string;
  portfolioId: string;
  cash: number;                         // cents
  positions: ReadonlyArray<{ symbol: string; quantity: number; avgCost: number }>;
  themeSymbols: ReadonlyArray<string>;
  prices: Readonly<Record<string, number | null>>;  // cents; latest close from price_bar (TimescaleDB)
  clock: { now: string; marketOpen: boolean };
}

interface OrderIntent {
  symbol: string;
  side: OrderSide;                      // "buy" | "sell"
  quantity: number;                     // > 0
}

interface Strategy {
  type: string;                         // registry key
  validateConfig(config: unknown): void;     // throws on invalid
  decide(ctx: StrategyContext, config: unknown): OrderIntent[];
}
```

The runner submits all intents to the order API without pre-filtering. The order
API is the single source of truth for validation; rejections are logged with a
reason. This keeps the bot runner stateless and the validation logic in one place.

### 1.2 Deferred: arbitrary user code

Running user-authored code (e.g. a sandboxed JS/WASM strategy, or a webhook the
runner calls) is **explicitly deferred**. If pursued, it must be sandboxed and
resource-capped (CPU/mem/time), network-restricted, and isolated from the API.
This is the sensitive trust boundary called out in
[01-architecture](01-architecture.md#5-trust-boundaries). Tracked in
[09-open-questions](09-open-questions.md).

## 2. House bot strategy types (initial registry)

These let the admin seed a varied, beatable-but-not-trivial field.

| `strategyType` | Nickname | Behavior sketch | `config` example |
|---|---|---|---|
| `random` | **lava lamp** | Each cycle, randomly buy/sell a random theme symbol within risk caps | `{ maxOrderPctOfEquity: 5, tradeProbability: 0.5 }` |
| `buy_and_hold` | the index | Spend cash spreading evenly across the theme once, then hold | `{ weighting: "equal" }` |
| `mixed` | mixed | Blend of `random` + `buy_and_hold` + `momentum` weighted by config | `{ weights: { random: 0.3, hold: 0.4, momentum: 0.3 } }` |
| `momentum` | momentum | Tilt toward recent winners in the theme | `{ lookbackCycles: 12, topN: 3 }` |
| `mean_reversion` | contrarian | Buy recent losers, trim recent winners | `{ lookbackCycles: 12 }` |
| `cash_drip` | dollar-cost | Deploy fixed cash slice each cycle into a target basket | `{ slicePct: 10, basket: "equal" }` |

> All configs are validated against a per-type schema (`validateConfig`).
> `random`/`mixed` use a **seeded** RNG so a bot's run is reproducible for audit
> (seed stored in `config`). Default risk caps: **max single order = 10% of
> current equity; max single position = 25% of current equity**. Individual
> strategies may tighten these via their `config`.

## 3. Seeding a season (admin)

Via `POST /admin/seasons/:id/bots` (v2 endpoint, see [03-api §9](03-api.md#9-v2--v3-endpoint-outlook)):

```ts
// Example payload: populate a fresh season's leaderboard
{
  "bots": [
    { "name": "lava lamp",   "strategyType": "random",       "count": 3 },
    { "name": "buy & hold",  "strategyType": "buy_and_hold" },
    { "name": "mixed",       "strategyType": "mixed",
      "config": { "weights": { "random": 0.3, "hold": 0.4, "momentum": 0.3 } } },
    { "name": "momentum",    "strategyType": "momentum",
      "config": { "lookbackCycles": 12, "topN": 3 } }
  ]
}
```

Each created bot gets: an `algo` row (`kind: "house"`, owner = admin) and a
`portfolio` in the season seeded with the standard `startingCapital`. From there
they're indistinguishable from human portfolios to the trade engine, and appear
on the leaderboard flagged `isBot: true`.

## 4. Scheduling & fairness

- Bots and user algos act **once per cycle** at the same cadence; no algo gets
  intra-cycle advantage.
- Fills use the same cached price as humans for that window
  ([04-game-mechanics §2.1](04-game-mechanics.md#21-fill-model)) — no latency edge.
- Per-algo order rate is bounded by the cycle cadence plus the API rate limits
  ([03-api §8](03-api.md#8-rate-limiting)).

## 5. Safety & limits

| Concern | Control |
|---|---|
| Untrusted code | v1 forbids it; only registered strategy types run |
| Runaway trading | Cycle cadence + per-type risk caps + API rate limits |
| Finnhub load | Bots read the shared quote cache; they never call Finnhub |
| Determinism/audit | Seeded RNG for stochastic strategies; orders/fills are immutable |
| Bad config | `validateConfig` rejects before an algo is enabled |

## 6. Bot/algo decisions (resolved)

- **Arbitrary user code:** deferred. v1 runs registered strategy types only.
  If pursued, sandbox options are WASM/isolate or an inbound webhook (user runs
  their own code externally and POSTs signals).
- **Intent rejection:** order API — single source of truth (see §1.1 above).
- **House bot risk caps:** max order 10% of equity; max position 25% of equity
  (configurable per strategy via `config`).
- **User algo cap:** **3 algos per user per season** to bound bot-runner load.
  Admin-created house bots are not subject to this cap.
