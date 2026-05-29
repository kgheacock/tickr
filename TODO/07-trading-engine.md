# 07 — Trading engine

> **Status:** pending • **Depends on:** 03, 04, 06

## Goal

Implement order submission, validation, immediate fill, and the
transactional portfolio mutation that follows. Includes the one-time
seeding of the `index` buy-and-hold bot owned by the system user.

## Pre-reads

- [docs/04-game-mechanics.md §2](../docs/04-game-mechanics.md#2-trading--fills)
  — fill model + rejection table.
- [docs/01-architecture.md §2.2](../docs/01-architecture.md#22-order-submission)
  — flow diagram.
- [docs/02-data-model.md §2.4, §2.5, §4](../docs/02-data-model.md#24-position)
  — position / order / fill schemas + invariants.
- [docs/03-api.md §3](../docs/03-api.md#3-portfolio--trading) — request
  envelope + rejection codes.

## Steps

1. **Order route.** `POST /api/v1/portfolios/:id/orders`:
   - Auth: caller must own the portfolio (or be admin for the bot).
   - Validate body against zod schema (`CreateOrderRequest`).
   - Idempotency: look up `(portfolio_id, idempotency_key)`; if found,
     return the prior `{ order, fill }`.
2. **Latest price.** `apps/api/src/trading/price.ts` exports
   `latestPrice(symbol)`:
   ```sql
   SELECT close, ts
   FROM price_bar
   WHERE symbol = $1
   ORDER BY ts DESC
   LIMIT 1
   ```
   Returns `{ price: number, ts: Date } | null`.
3. **Validation order.** All checks before any write:
   - `universe_symbol.symbol = $sym AND backfilled = true` → else
     `SYMBOL_NOT_TRADEABLE`.
   - `latestPrice.ts` within 5 calendar days of `now()` → else `STALE_PRICE`.
   - `quantity > 0` → else `VALIDATION`.
   - Buys: `portfolio.cash >= ceil(quantity × price)` → else
     `INSUFFICIENT_FUNDS`.
   - Sells: `position.quantity >= quantity` for `(portfolio, symbol)` → else
     `INSUFFICIENT_POSITION`.
4. **Transactional execution.** Single `BEGIN…COMMIT`:
   - INSERT `trade_order` (`status='filled'`).
   - INSERT `fill`.
   - UPSERT `position`:
     - Buy: `quantity += $q`, `avg_cost = ((existing.qty × existing.avg) +
       ($q × $px)) / new_qty`.
     - Sell: `quantity -= $q`; if new `quantity = 0`, delete the row;
       `avg_cost` unchanged on sells.
   - UPDATE `portfolio.cash`: `cash -= $q × $px` (buy) or `cash += $q × $px`
     (sell).
   - Wrap with `SELECT … FOR UPDATE` on the portfolio row to serialize
     concurrent orders against the same portfolio.
5. **Money arithmetic.** Round `quantity × price` to integer cents using
   `Math.round` (or banker's rounding — pick and document). Treat
   `position.quantity` as `NUMERIC(20,8)`; do math via `decimal.js` in
   the api to avoid float drift, persist as numeric. Cents stay as JS
   `number` (safe through ~$9e13).
6. **Cancel endpoint.** `POST /portfolios/:id/orders/:orderId/cancel`.
   v1 orders fill immediately, so cancel returns `409 CONFLICT` with
   `ORDER_ALREADY_FILLED` for any order that has a `fill`. The route
   exists so the API surface matches v2+ where resting orders appear.
7. **Index bot seeding.** `apps/api/src/bot/seed-index.ts` (runs in the
   `bot` role at startup, after a Redis lock):
   ```
   if "index" algo row exists with portfolio.algo_id and ≥ 1 fill: return
   if COUNT(*) FROM universe_symbol WHERE backfilled = false > 0: return
     // wait for full backfill (G8b); re-runs on next startup
   create algo (kind='house', strategy_type='buy_and_hold', owner=system)
   create portfolio (user=system, algo_id=algo.id, cash=100_000_000)
   N = COUNT(*) FROM universe_symbol WHERE backfilled = true
   per_symbol_budget_cents = floor(100_000_000 / N)
   for each backfilled symbol:
     px = latestPrice(symbol).price
     qty = (per_symbol_budget_cents / px), rounded to 8 dp
     call executeTrade({ portfolioId, symbol, side:'buy', qty, idempotencyKey: "index-seed:<sym>" })
   ```
   Call the trading-engine function **in-process** (A6 decision: trusted internal
   caller). Full validation still runs; no session/CSRF check required. Do **not**
   use the HTTP route — the bot has no SSO session.
8. **Reads.** Endpoints:
   - `GET /portfolios/:id` → `PortfolioView` (cash, positions joined with
     latest `price_bar.close`, equity, `lastSnapshotAt`).
   - `GET /portfolios/:id/orders?limit=&cursor=` paginated, newest first.
   - `GET /portfolios/:id/history?limit=&cursor=` from `valuation_snapshot`
     newest first.
9. **Tests.** Integration tests using a real Postgres via testcontainers:
   - Buy reduces cash and creates/updates position.
   - Sell of full holding deletes the position row.
   - Duplicate idempotency key returns the prior order, no double fill.
   - Concurrent buys for the same portfolio serialize (no negative cash).
   - Rejection branches each emit the documented code.
   - Index seed creates one algo, one portfolio, and N fills; re-running
     is a no-op.

## Files to create

- `apps/api/src/trading/price.ts`
- `apps/api/src/trading/validate.ts`
- `apps/api/src/trading/execute.ts`
- `apps/api/src/trading/money.ts`
- `apps/api/src/routes/portfolios/*.ts`
- `apps/api/src/bot/seed-index.ts`
- `apps/api/test/trading/*.test.ts`
- `apps/api/test/bot/seed-index.test.ts`

## Definition of done

- [ ] All six rejection branches return the documented `code` with status
      422 (or 409 for idempotency conflicts).
- [ ] A buy that would overdraw is rejected; `cash` is unchanged.
- [ ] `position.avg_cost` after two buys at different prices is the
      weighted average (verified to within 1 cent).
- [ ] Selling exactly the held quantity deletes the position row;
      `position.quantity >= 0` invariant never violated.
- [ ] Index bot exists with N fills covering all backfilled symbols;
      restarting the bot container does not produce more fills.
- [ ] `GET /portfolios/:id` returns equity computed from the latest
      `price_bar.close`, with `lastSnapshotAt` populated once item 08 has
      run at least once.
