# 04 — Game Mechanics

> This doc describes **v1 rules in the body** and previews v2+ in §6. Where
> a number isn't yet decided it is marked **TODO**.

## 1. The game (v1)

v1 is **one perpetual leaderboard**. There are no seasons, no themes, and
no end date. Every player has a single portfolio that persists from sign-in
forever.

| Rule | Value |
|---|---|
| Starting capital | **$1,000,000** (`100_000_000` cents) — identical for every player |
| Tradeable universe | Full S&P 500 (~500 symbols) — any backfilled `universe_symbol` |
| Order types | **Market only** |
| Trading window | **24/7** |
| Fill price | The most recent `price_bar.close` from TimescaleDB |
| Snapshot cadence | **Once daily** after the US market close |
| Leaderboard metric | Total equity (`cash + Σ qty × latest close`) |
| Fees | **None** |
| Bots | Exactly one: the **`index`** buy-and-hold of an equally-weighted S&P 500 basket |
| User algos | Not in v1 (v3) |

### 1.1 Player onboarding

```
1. Sign in via Google or GitHub (see 05-auth)
2. On first sign-in:
     create app_user row
     create portfolio row (cash = 100_000_000, algo_id = null)
3. Land on /portfolio — start trading immediately
```

There is no "join" step in v1 because there is nothing to join — the
perpetual leaderboard is the only game state.

### 1.2 The `index` bot

A single house bot, owned by a **system user** (an `app_user` row seeded
at install with a reserved `id`, `role = 'admin'`, and no `identity`
rows — it never signs in). Seeded once at system bootstrap, after the
bootstrap backfill has marked **all** seeded `universe_symbol` rows
`backfilled = true`:

```
1. Seed system user row (idempotent: skip if it already exists)
2. Create algo row: name = "index", strategy_type = "buy_and_hold",
                    kind = "house", owner_user_id = system_user.id,
                    config = { weighting: "equal" }
3. Create portfolio row (cash = 100_000_000, algo_id = the new algo,
                         user_id = system_user.id)
4. Place market buy orders, one per backfilled universe_symbol,
   each sized to ~ 1/N of starting capital where N = backfilled count
5. The bot does not trade again — it just holds
```

The system-user approach avoids a chicken-and-egg with the human admin
(provisioned only on first matching SSO sign-in via `ADMIN_BOOTSTRAP`).
If new symbols become tradeable later, the bot is **not** rebalanced —
it holds its original basket forever. v2 will revisit bot rebalancing.

This populates the leaderboard from day one and gives players a
hard-to-beat baseline (an equal-weighted index hold). v2 expands this to
the full bot registry described in
[07-bots-and-algos](07-bots-and-algos.md).

## 2. Trading & fills

v1 supports **market orders only**.

### 2.1 Fill model

**Immediate fill at the most recent `price_bar.close` for the symbol.**

- Pros: simple, deterministic, no resting-order machinery, no latency edge
  (everyone within a day fills at the same close price).
- Cons: ignores slippage, spread, and intraday movement.
- v1 specific: prices update once daily, so during the day the most recent
  close is the prior trading day's. After 16:30 ET it is today's; on
  Monday morning it is Friday's. The cadence change in v2 (snapshots every
  5 min) tightens this.

> **Fairness consideration:** Because everyone fills at the same cached
> price within a day, no player gets a latency edge. This is intentional.

### 2.2 Rejections

Orders are rejected (not silently dropped) with a specific `code` when:

| Reason | Code |
|---|---|
| Symbol not in `universe_symbol` or `backfilled = false` | `SYMBOL_NOT_TRADEABLE` |
| Latest `price_bar` for the symbol is > 5 calendar days old | `STALE_PRICE` |
| `quantity <= 0` | `VALIDATION` |
| Buys: `cash < quantity × price` | `INSUFFICIENT_FUNDS` |
| Sells: holding < `quantity` (no shorting) | `INSUFFICIENT_POSITION` |
| Idempotency key collides with a prior rejection | replay original result |

### 2.3 Buying power

- **Buying power = cash** in v1. No margin, no leverage, no shorting.
- Hard invariants (see [02-data-model §4](02-data-model.md#4-invariants)):
  `cash >= 0`; `position.quantity >= 0`.

## 3. Snapshots & leaderboard

### 3.1 Daily EOD snapshot

Once per day, after the US market close, the worker runs:

```
1. Daily price update (REST /quote for every backfilled symbol)
2. For each portfolio:
     read latest price_bar.close per held symbol
     equity = cash + Σ (quantity × close)
     write a valuation_snapshot row (immutable)
3. Rank portfolios by equity → write leaderboard_row rows
4. Refresh Redis leaderboard cache
5. Emit a leaderboard.updated WS event
```

Steps 2–4 take seconds; the dominant cost is the REST poll (~8.5 min for
500 symbols at 60 req/min — see
[08-deployment §2](08-deployment.md#2-finnhub-integration)).

### 3.2 Leaderboard

- **Metric:** total equity (cash + Σ qty × latest close) at the latest
  snapshot.
- **Display also shows:** return % vs. starting capital.
- **Ordering:** equity descending.
- **Tie-breaking:** ties share a rank; stable secondary sort by
  `portfolioId` (UUID, deterministic). Risk-adjusted tie-breaking is a
  future option.
- **The `index` bot is ranked alongside humans** and flagged
  (`isBot: true`).

### 3.3 Intraday equity (UI-only)

The `/portfolios/:id` view returns a best-effort live equity computed from
the latest known `price_bar.close` per held symbol. This is for UX only —
the **official ranking** is the latest `valuation_snapshot`, which moves
once a day.

## 4. Off-hours, holidays, missing prices

- Orders accepted 24/7. Fills always use the latest available
  `price_bar.close` — weekends and holidays fill at Friday's close.
- If a symbol's latest bar is older than **5 calendar days** (≈120 h),
  orders for it are rejected with `STALE_PRICE`. The threshold survives a
  3-day weekend plus the daily-update window, so a normal holiday Monday
  doesn't trigger rejections — only an actually-stuck feed (delisting,
  prolonged backfill failure) does. The admin can resolve via
  `/admin/universe/upsert` or by re-running backfill.

## 5. Anti-abuse

- One portfolio per user in v1, enforced by the `portfolio_one_human_per_user`
  partial index (`(user_id) WHERE algo_id IS NULL`). A plain
  `UNIQUE (user_id, algo_id)` would not work because Postgres treats
  `NULL ≠ NULL`.
- Rate limits on `POST /portfolios/:id/orders` to prevent spam and protect
  the Finnhub budget ([03-api §8](03-api.md#8-rate-limiting)).
- Idempotency keys dedupe accidental double-submits.
- All players share the same universe, capital, and fill prices — the
  surface for "unfair edge" is small by construction.

## 6. v2+ outlook

v2 wraps the v1 portfolio in **seasons** (bounded windows) with a
**theme** (constrained universe) per season:

- Season lifecycle: `draft → scheduled → active → settling → closed`.
  Trading and joining gated by status; late-join allowed until ~25% of
  duration elapsed (TODO confirm).
- Snapshot cadence becomes `season.snapshotIntervalSec` (default **300 s**
  / 5 min), not daily.
- Fill model unchanged in form — still the latest `price_bar.close` — but
  the cadence change means closes update every 5 min, so intraday
  trading is meaningful.
- Themes constrain the tradeable universe per season (Big 7, Top 50,
  Energy, …).
- The single v1 `index` bot expands into the **full strategy registry**
  in [07-bots-and-algos](07-bots-and-algos.md): `random`, `buy_and_hold`,
  `mixed`, `momentum`, `mean_reversion`, `cash_drip`.
- Per-season starting capital remains $1M by default but is a
  `season.starting_capital` field, configurable per season.

v3 adds **user-authored algos**: a player picks a registered strategy
type, supplies validated config, and attaches it as a portfolio driver.
3 algos per user per season cap (TODO confirm). Arbitrary user code stays
deferred.

Open mechanics items consolidated in
[09-open-questions](09-open-questions.md).
