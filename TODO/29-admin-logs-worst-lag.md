# 29 — Admin logs: backfill status → worst price-bar lag

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/78) • **Depends on:** 10, 23

## Goal

Replace the `/admin/logs` **backfill status** chip (built in [item 23](23-admin-logs-meta-and-status.md))
with the **worst price-bar lag in the DB**: the playable symbol whose latest bar
is furthest behind the freshness reference. Backfill-remaining trends toward a
permanent zero once the corpus is hydrated, so it stopped being a useful
at-a-glance signal; the most stale symbol is the thing an admin actually wants
to catch.

## Context / constraints

- **Freshness reference is `min(now, closingTime)`, generalized.** Fresh bars are
  expected up to ~now *during* a live session (the intraday sweep runs every
  5 min — `scheduler.ts`), but only up to the most recent NYSE close off-hours.
  So the reference is `isRegularSession(now) ? now : mostRecentClose(now)`, which
  keeps weekends/holidays from reading as lag.
- **`mostRecentClose` walks back over closures.** New helper in
  `market/holidays.ts`: the most recent 16:00-ET session close at or before now,
  stepping back over weekends and holidays, DST-correct via `Intl` (no hand-rolled
  offsets).
- **Mirror the playable corpus exactly.** The worst-lag query's predicate
  (`backfilled = true AND removed_at IS NULL AND data_status IS DISTINCT FROM
  'incomplete'`) mirrors `runIntradayUpdate`'s selection — those are the symbols
  we keep fresh. Removed/incomplete symbols are intentionally stale and would
  otherwise masquerade as the worst lag forever.
- **Index-friendly, not a hypertable scan.** A `CROSS JOIN LATERAL` computing
  `max(ts)` per symbol hits the `(symbol, ts)` PK index per symbol instead of
  scanning `price_bar`. A backfilled symbol with zero bars is the data audit's
  job (Finding 4), not a lag we can measure, so it is filtered out.
- **Neutral chip by design — no health-colored threshold.** The worst lag
  legitimately spikes to "time since last close" every trading morning (the worst
  symbol sits on the prior close until the ~100-min sweep catches it — ~17h on
  weekdays, ~65h after a weekend), so any fixed red/amber threshold would scream
  daily during normal operation. The chip shows the number in neutral grey and
  only turns red when the `/admin/ops` poll itself fails.

## Steps (as built)

1. **`mostRecentClose(now)`** (`market/holidays.ts`). Most recent 16:00-ET close
   ≤ now, walking back over weekends/holidays; reuses the existing NYSE holiday
   set and a two-step zoned→UTC conversion.
2. **`worstLag` on `/admin/ops`** (`routes/admin/ops.ts` + `openapi.yaml`).
   Lateral `max(ts)` over the playable corpus picks the oldest latest-bar;
   `lagSec = max(0, referenceTs − latestBar)`. Added to `OpsResponse`
   (regenerated `openapi.gen.ts`).
3. **Worst-lag chip** (`routes/admin/logs.ts`). The header chip + 20s poll swap
   from backfill to worst-lag, rendered neutral (number only); dead `ok`/`busy`
   CSS removed.

## Files

- `apps/api/src/market/holidays.ts` _(`mostRecentClose`)_
- `apps/api/src/routes/admin/ops.ts` _(`worstLag` query + field)_
- `apps/api/src/routes/admin/logs.ts` _(chip + poll, neutral render)_
- `packages/shared-types/openapi.yaml` _(+ regenerated `openapi.gen.ts`)_

## Entry point

`https://tickr.keithheacock.com/api/v1/admin/logs` — requires an admin session.

## Definition of done

- [x] `/admin/logs` header chip shows the worst price-bar lag (`lag · SYMBOL
      <dur>`) instead of backfill status, polled from `/admin/ops`.
- [x] The lag reference is `min(now, closingTime)` generalized: `now` in-session,
      else `mostRecentClose(now)`, so weekends/holidays don't read as lag.
- [x] The worst-lag query mirrors `runIntradayUpdate`'s playable predicate and
      uses a per-symbol lateral `max(ts)` (PK index, not a hypertable scan);
      zero-bar symbols are excluded.
- [x] `worstLag` is added to `OpsResponse` in `openapi.yaml` and the generated
      types are regenerated.
- [x] Chip is neutral (number only), red only on poll failure — no fixed health
      threshold that would false-alarm during the daily open warm-up.
- [x] Unit tests cover `mostRecentClose` (mid-session, post-close EDT/EST,
      weekend, holiday, exact close); integration tests cover the worst-lag pick
      and the playable-set exclusions. `tsc --noEmit`, prettier, and eslint clean.
