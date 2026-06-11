# 25 — Universe source: hardcoded CSV → live Wikipedia constituents

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/64) • **Depends on:** 03, 13

## Goal

Stop seeding the trading universe from a hardcoded, hand-maintained
`apps/api/data/sp500.csv` and instead **reconcile it against the live S&P 500
constituent list from Wikipedia** on each bootstrap. The list drifts (~20–25
changes/yr, mostly at the quarterly rebalance), so a static CSV silently rots.
Membership changes must be reflected **without ever dropping a ticker from the
DB** — a stock that leaves the index becomes terminal (`removed_at`), keeping its
row + price history for anything that references it (e.g. a future Fantasy Street
roster pick — "out for the season").

## Pre-reads

- [TODO/13-massive-client.md](13-massive-client.md) — Massive has **no
  constituents endpoint** (`I:SPX` exists; `/v3/snapshot/indices` is paywalled;
  `/v3/reference/tickers` can't sort by market cap). Verified live by
  `scripts/probe-massive-constituents.ts` and `scripts/probe-massive-sort.ts`.
- [TODO/03-database-schema.md](03-database-schema.md) — `universe_symbol`
  (`removed_at` is the active-membership marker) and the original CSV seed.
- [TODO/19-data-audit.md](19-data-audit.md) — `prune-dead` and the data audit
  that motivated the dotted-symbol fix.

## Steps

1. **Wikipedia source** (`apps/api/src/universe/wikipedia.ts`) —
   `fetchSp500Symbols()` pulls the page wikitext via the MediaWiki action API and
   parses `{{Nyse/NasdaqSymbol|…}}` templates into **dotted** symbols (`BRK.B`),
   matching Massive/Polygon. Plausibility floor (≥450) so a moved/changed page
   can't drive a mass purge. Injectable `fetchFn` for tests.
2. **Reconcile seed** (`db/seed-universe.ts`) — add new members, reactivate
   returners (clear `removed_at`), retire departed (set `removed_at`, **never
   DELETE**). Per-run departure cap (`UNIVERSE_MAX_DEPARTURE_FRACTION`, default
   0.1). On fetch failure, fall back to the bundled CSV for **inserts only**.
3. **Dotted symbols everywhere** — migration `011_universe-dash-to-dot` renames
   existing `BRK-B`/`MOG-A` rows across `universe_symbol` + all FK children
   (`price_bar`, `etf_weight`, `symbol_metadata`, `symbol_branding`) so no history
   is orphaned. CSV fallback regenerated to dots. `toMassiveTicker` stays a
   defensive no-op.
4. **Never drop a ticker** — `prune-dead` switches from hard `DELETE` to soft
   `removed_at`; `backfill` already filters `removed_at IS NULL`.
5. **Docs + tests** — `.env.example` documents `UNIVERSE_MAX_DEPARTURE_FRACTION`
   and the first-run override; unit/integration tests for the parser, reconcile,
   migration child-preservation, and dotted-symbol path routing.

## Definition of done

- [x] `fetchSp500Symbols()` returns dotted constituents from Wikipedia; a
      below-floor / failed / errored fetch throws (verified against the live page:
      502 symbols, `BRK.B`/`BF.B` present).
- [x] `seedUniverse` reconciles: adds new, reactivates returners, retires departed
      via `removed_at`, never deletes; departure cap and CSV fallback covered by
      tests.
- [x] Symbols stored in dotted form; migration 011 renames the dashed rows across
      every FK child with **no row or history loss** (proven by
      `test/db/dash-to-dot.test.ts`).
- [x] `prune-dead` soft-retires (no hard delete); the "never drop a ticker"
      invariant holds end-to-end.
- [x] No endpoint breaks on dotted symbols: `/prices` (query), WS (JSON/Redis
      channel), and the one symbol-in-path route (`/symbols/:symbol/logo`) all
      verified — dotted `BRK.B` resolves through Fastify (branding test).
- [x] `.env.example` documents the departure-cap knob + first-run override; full
      `pnpm --filter @tickr/api test` green (225 passed / 1 skipped).
- [x] **Follow-up:** schedule the reconcile in the `worker` role (cron) so the
      universe self-refreshes without a manual `pnpm backfill`/`metadata` run —
      done in [item 26](26-schedule-data-jobs-cron.md)
      ([PR #66](https://github.com/kgheacock/tickr/pull/66)).
- [x] **Deploy:** ran the first prod reconcile (2026-06-11) with
      `UNIVERSE_MAX_DEPARTURE_FRACTION=0.2` — cleared the backlog (inserted 75,
      retired 63 against the live Wikipedia list); steady-state stays under the
      default 0.1 cap.
