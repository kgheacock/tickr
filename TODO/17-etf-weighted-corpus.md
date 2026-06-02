# 17 — ETF over a weighted corpus

> **Status:** pending • **Depends on:** 16

## Goal

Let a caller define an **ETF**: a named, reusable basket of universe symbols
with per-symbol weights. An ETF behaves like a **synthetic symbol** — its
price series is the weighted combination of its members' `price_bar` history,
and it flows through the same `/prices` and `/evaluate` endpoints as a real
symbol rather than living in a parallel system.

This is the only weighted-subset abstraction on top of the single corpus
(see item 16, D1).

## Pre-reads

- [16-platformize-api.md](16-platformize-api.md) — the platform this extends;
  especially the `/prices` and `/evaluate` shapes and D1 (one corpus).
- [docs/02-data-model.md §2.10](../docs/02-data-model.md#210-price_bar-timescaledb)
  — the `price_bar` series the synthetic price is derived from.

## Design decisions (pin these before coding)

- **D1 — ETFs are stored entities.** "Defining an ETF" implies a reusable,
  named thing, so it needs persistence. This reintroduces a small slice of
  state that item 16 removed — keep it minimal: two tables, no auth, no
  ownership.
  ```sql
  CREATE TABLE etf (
    id          UUID PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,   -- stable handle, e.g. "big7"
    name        TEXT NOT NULL,
    base_value  BIGINT NOT NULL DEFAULT 10000,  -- cents; index level at base_date
    base_date   DATE NOT NULL,          -- t0 the series is normalized to
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE etf_weight (
    etf_id  UUID NOT NULL REFERENCES etf(id) ON DELETE CASCADE,
    symbol  TEXT NOT NULL REFERENCES universe_symbol(symbol),
    weight  NUMERIC(12,8) NOT NULL CHECK (weight > 0),
    PRIMARY KEY (etf_id, symbol)
  );
  ```
- **D2 — Weights normalize.** Accept arbitrary positive weights; normalize to
  sum 1.0 at compute time. Reject creation if any member is not in
  `universe_symbol`, or (recommended) if any member is not `backfilled`.
- **D3 — Synthetic price = normalized weighted index.** Define the ETF level
  at date *t* as `base_value × Σ_i (w_i × close_i(t) / close_i(base_date))`.
  This is a rebased, weighted price index (handles members with very
  different share prices). On a date where a member has no bar, carry its last
  prior close forward; if a member has no bar at/before `base_date`, reject
  the ETF (its base is undefined). Document this and treat it as the one
  modeling knob.
- **D4 — ETF is a synthetic symbol, not a new endpoint family.** `/prices`
  and `/evaluate` accept an ETF `key` (namespaced, e.g. `etf:big7`) anywhere
  a symbol is accepted; the resolver expands it to its synthetic series. No
  parallel `/etf/.../prices` surface.

## Steps

1. **Schema.** Migration creating `etf` + `etf_weight` (D1).
2. **Define / read endpoints:**
   - `POST /api/v1/etfs` — `{ key, name, baseDate?, baseValue?, weights: Record<symbol, number> }`.
     Validate members ∈ universe (D2), weights > 0, key unique. Persist.
   - `GET /api/v1/etfs` — list defined ETFs (key, name, member count).
   - `GET /api/v1/etfs/:key` — detail incl. normalized weights.
3. **Synthetic price series.** `apps/api/src/etf/series.ts` exports
   `etfSeries(key, from, to)` computing the D3 index from member `price_bar`
   rows. One query pulls all members' bars over the window; fold per date.
4. **Wire into `/prices`.** Teach the symbol resolver to recognize an ETF
   handle and substitute `etfSeries(...)`. `GET /prices?symbols=etf:big7&...`
   returns the synthetic OHLC-style series (at minimum `close`; `open/high/low`
   may equal `close` for a derived index — document).
5. **Wire into `/evaluate`.** An order whose `symbol` is an ETF handle fills
   at the synthetic close at-or-before `order.at` (same point-in-time policy
   as 16, D5). Quantity = units of the synthetic index. Returns compose
   normally.
6. **`GET /api/v1/etfs/:key/returns`** (convenience) — total return % of the
   ETF over `?from=&to=` straight from the series, for callers who want the
   basket's performance without constructing orders.
7. **Tests** (testcontainers; seeded members + bars):
   - Create → list → read round-trips; unknown member rejected.
   - A two-member 50/50 ETF over a window where one member doubles and the
     other is flat returns ≈ +50% — verifies normalization + rebasing.
   - `/prices?symbols=etf:<key>` returns the synthetic series; mixed
     real-symbol + ETF request works.
   - `/evaluate` with an ETF order fills at the point-in-time synthetic close.
   - Missing-bar carry-forward and undefined-base rejection behave per D3.

## Files

- Create: `apps/api/migrations/*_etf.sql`, `apps/api/src/routes/etfs.ts`,
  `apps/api/src/etf/series.ts`, `apps/api/src/etf/resolve.ts` (handle →
  series), `apps/api/test/etf/*.test.ts`.
- Edit: `routes/prices.ts`, `routes/evaluate.ts` (accept ETF handles via the
  resolver); `@tickr/shared-types` (`Etf`, `EtfWeight`, request/response).

## Definition of done

- [ ] An ETF can be created from a weighted set of universe symbols and read
      back with normalized weights.
- [ ] `GET /prices?symbols=etf:<key>` returns the rebased weighted index over
      the window; a known 50/50 basket reproduces the expected return.
- [ ] `POST /evaluate` accepts ETF handles and fills at the point-in-time
      synthetic close.
- [ ] Members must exist in `universe_symbol`; undefined-base and unknown
      members are rejected with clear errors.
