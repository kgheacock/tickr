# 18 — Display logic: ETF editor, strategy & performance plot

> **Status:** pending • **Depends on:** 16, 17
>
> Item 16 stops at the live-update spine (auth + CSRF + sessions + WS that
> **logs to console**) with no display. This item is where that graduates
> into a real client: edit an ETF, run a trading strategy against it, and plot
> the result. Item 17 provides the ETF backend this builds on.

## Goal

Give an authenticated user an end-to-end loop:

1. Start from a **seeded S&P 500 ETF**.
2. **Edit** it into their own ETF (change members / weights).
3. Run a **trading strategy** over that ETF.
4. See a **performance plot** of the ETF under that strategy.

The strategy is **fixed and built-in to start** (defined below). "Define your
own algorithm" is the future direction, not this item.

## Steps

### 1. Seed the S&P 500 as an ETF definition

Add functionality to seed the S&P 500 allocation as an ETF (item 17's
`etf` + `etf_weight` tables). This is the default starting point every client
loads.

- Seed key `sp500`, name "S&P 500".
- **Allocation:** equal-weight across all `backfilled = true`
  `universe_symbol` rows (mirrors the old built-in `index` basket — equal
  weights, `weight = 1` each, normalized at compute time per item 17 D2).
  Market-cap weighting is a later refinement; record the choice and move on.
- Seed at startup (idempotent, like the old index-bot seed) or via an admin
  one-shot. It depends on the corpus being backfilled (item 16 cron); re-seed
  when membership changes, or treat `sp500` as a refreshable system ETF.

### 2. Client: fetch and edit the ETF

- On load, fetch `sp500` via `GET /etfs/sp500` (item 17).
- Let the user **fork/edit** it into their own ETF: add/remove member symbols
  (from `GET /universe`, item 16) and adjust weights, then save via
  `POST /etfs` (their own `key`). Weights normalize on save (item 17 D2).
- This is the first real UI surface — replaces item 16's console logging for
  the ETF flow.

### 3. Built-in trading strategy (fixed, to start)

Define **one** built-in strategy: a **simple moving-average (SMA) crossover**
on the ETF's synthetic price series (item 17 D3) — the canonical "basic
algorithmic trading strategy."

- **Signal:** compute a short SMA (default **20** daily closes) and a long SMA
  (default **50**). Go fully invested when short crosses **above** long; go
  fully to cash when short crosses **below** long.
- **Orders:** translate signals into a series of `{ symbol: "etf:<key>",
  side, quantity, at }` orders over the backtest window (a buy of the whole
  cash balance on the up-cross, a sell of the whole position on the
  down-cross).
- **Backtest:** feed that order series to `POST /evaluate` (item 16) with a
  fixed `startingCash`. Point-in-time fills (item 16 D5) make this a faithful
  historical replay. The `EvaluateResponse.equityCurve` is the strategy's
  performance.
- **Where it runs:** the strategy may live client-side (compute SMAs from
  `/prices`/`/etfs/:key/returns`, post orders to `/evaluate`) or as a thin
  backend helper. Pick at impl; a backend strategy module is the natural home
  for the future "user-defined algorithm" work, so leaning backend is
  recommended. Either way the SMA params are fixed defaults in this item.

### 4. Performance plot

Render a performance plot of the chosen ETF under the strategy:

- Plot the strategy `equityCurve` over the window.
- Overlay a **buy-and-hold baseline** of the same ETF (hold from day one) so
  the strategy has something to be measured against.
- Show headline stats: total return %, and (nice-to-have) max drawdown.

## Future direction (out of scope here)

- User-authored / configurable strategies (parameterized, then richer logic).
- Market-cap or custom weighting schemes for the seeded S&P 500 ETF.
- Live (WS-driven) re-evaluation as new daily bars arrive.

## Relationship to item 11

[11-frontend.md](11-frontend.md) is the broader frontend SPA and also depends
on 16. Decide at planning time whether this ETF-editor + plot work is a slice
of 11 or folds into it; keep the two consistent and avoid duplicate views.

## Definition of done

- [ ] An `sp500` ETF is seeded (equal-weight over backfilled universe symbols)
      and fetchable via `GET /etfs/sp500`.
- [ ] A user can fork `sp500`, edit members/weights, and save their own ETF.
- [ ] The built-in SMA-crossover strategy produces an order series that runs
      through `POST /evaluate` and returns an equity curve for the ETF.
- [ ] The client renders a performance plot of the ETF under the strategy,
      with a buy-and-hold baseline overlay and total-return %.
