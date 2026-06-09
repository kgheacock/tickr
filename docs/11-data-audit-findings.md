# 11 — Data Audit Findings

> Audit run: 2026-06-08  
> Script: `pnpm tsx scripts/data-audit.ts`  
> Window: 2024-06-08 → 2026-06-07 (730 days, 15-minute granularity)

## Summary

| Metric | Count |
|---|---|
| Total symbols | 492 |
| Clean | 0 |
| Warnings only | 0 |
| Errors | 492 |

Error/warning counts by code:

| Code | Count |
|---|---|
| `INTRADAY_GAP` | 484 |
| `COVERAGE_GAP` | 549 |
| `NO_BARS` | 4 |
| `SPLIT_CANDIDATE` | 3 |
| `OHLC_VIOLATION` | 0 |
| `DUPLICATE_BAR` | 0 |
| `CROSS_SOURCE_DEVIATION` | 0 |

---

## Finding 1 — `INTRADAY_GAP: no_session_bars` (484 symbols)

**Severity:** Error — blocks production deployment.

### What the audit saw

Every bar for 484 of 492 symbols has `ts = 00:00:00Z`. None fall within the
13:00–22:00 UTC window that the `INTRADAY_GAP` check treats as US market session
hours. The corpus therefore appears to be daily-resolution data, not 15-minute
intraday data. Typical bar counts (~494–499 per symbol) confirm this: two years
of 15-minute bars for an active symbol would produce ~13,000 rows; 499 matches
roughly 499 trading days.

### Root cause

The corpus was bootstrapped using the now-removed Kaggle backfill script
(`scripts/kaggle-backfill.ts`, deleted). That script converted the Kaggle CSV
date column via `new Date(r.date).getTime()`, which JavaScript parses as midnight
UTC (`00:00:00Z`) for date-only strings like `"2020-01-15"`. All bars were stored
with `ts = midnight UTC` — 13–14 hours before the NYSE open.

The Massive historical backfill (`apps/api/src/jobs/backfill.ts`) only processes
symbols where `universe_symbol.backfilled = false`. The Kaggle script set
`backfilled = true` on completion, permanently blocking the Massive job from
fetching real intraday bars for those symbols.

The daily session-update job (`apps/api/src/jobs/intraday-update.ts`) only appends
the trailing `SESSION_LOOKBACK_DAYS` (default 4) days of Massive data. Even if it
had been running continuously, it would not retroactively fill two years of
15-minute history.

> **Status as of 2026-06-08:** The Kaggle client has been removed from the
> codebase. The path forward is to reset `backfilled = false` for all affected
> symbols and run `pnpm backfill` to fetch real intraday bars from Massive.

### Net effect

The price-bar corpus is entirely daily bars (midnight UTC timestamps) rather than
the 15-minute intraday bars the system was designed to serve. Return calculations,
portfolio valuation, and chart rendering all depend on intraday timestamps being
present; daily-only bars will produce incorrect or empty results.

---

## Finding 2 — `COVERAGE_GAP` (549 instances)

**Severity:** Error — blocks production deployment.

### What the audit saw

Roughly a third of symbols have one or more runs of 5–11 consecutive missing
trading days. The gaps cluster near the audit end date (late May – early June
2026). Examples: AAPL missing 2026-06-01–2026-06-05 (5 days), BK missing
2026-05-21–2026-06-05 (11 days).

### Root cause

The trailing gap is a direct consequence of Finding 1. The intraday session-update
job (`intraday-update.ts`) is responsible for adding recent bars each evening after
market close (21:30 UTC). Its self-healing window is only 4 days
(`SESSION_LOOKBACK_DAYS`). In the dev environment the service is not running
continuously, so recent trading days are never populated. The Kaggle dataset has a
fixed cutoff (mid-2024), so any days after that cutoff require Massive data.

Once the intraday data problem (Finding 1) is resolved, most COVERAGE_GAP instances
are expected to disappear as the session-update job catches up within its lookback
window. Symbols with longer gaps may require a targeted Massive re-fetch.

---

## Finding 3 — `NO_BARS` (4 symbols)

**Severity:** Error.

### What the audit saw

Four symbols in `universe_symbol` have zero `price_bar` rows in the 730-day window.

### Root cause

These symbols were either absent from the Kaggle dataset or had all rows rejected
during parsing (e.g. `NaN` in price fields, logged as a `warn` in `parseHistory.ts:71-75`).
Once skipped by the Kaggle run, there is no fallback: the Massive backfill only
processes `backfilled = false`, but since these symbols may have been partially
handled or left in an ambiguous state, they were never retried. The specific symbols
are not recorded in this document — run the audit and filter for `NO_BARS` in the
JSON output to identify them.

---

## Finding 4 — `SPLIT_CANDIDATE` (3 symbols, warning)

**Severity:** Warning — does not block deployment but requires manual review.

### What the audit saw

Three symbols have consecutive-day close ratios within 3% of a common stock split
factor (0.5× for a 2:1 forward split, 2.0× for a 1:2 reverse split).

### Root cause

The Kaggle dataset provides raw, unadjusted prices. The Massive API response schema
includes an `adjusted` field on `AggregatesResponse` (`massive.gen.ts:76`), but
neither the Kaggle nor Massive ingestion path logs or validates this flag. If a
split occurred during the coverage window and the source provides unadjusted prices,
the price series will have a discontinuity on the split date. The audit script
comment in `data-audit.ts:17-20` already notes this as a known v1 limitation.

No action is required before v1 deployment if split-adjusted prices are confirmed
from the data source. If prices are unadjusted, a manual `adj_close` migration
and per-position quantity correction are needed before live trading.

---

## Checks that passed

- **`OHLC_VIOLATION`: 0** — All stored OHLC values satisfy `low ≤ open, close ≤ high`
  and `volume ≥ 0`. The Kaggle daily bars are internally consistent.
- **`DUPLICATE_BAR`: 0** — No duplicate `(symbol, ts)` entries. The `ON CONFLICT DO NOTHING`
  in `insertBars.ts` and the Kaggle sequential-symbol streaming in `parseHistory.ts`
  together prevent double-inserts.
- **`CROSS_SOURCE_DEVIATION`: 0** — No symbols have both daily-midnight bars and
  intraday bars for the same date, so the cross-source reconciliation query finds
  nothing to compare. This is consistent with the conclusion that no Massive intraday
  bars exist in the corpus.

---

## Fix priority

| Priority | Finding | Fix summary |
|---|---|---|
| 1 | Findings 1A+1B | Kaggle client removed. Reset `backfilled = false` for all affected symbols and run `pnpm backfill` to fetch real intraday bars from Massive. |
| 2 | Finding 2 | Extends from Fix 1; ensure the session-update job runs nightly in the target environment. |
| 3 | Finding 3 | Identify the 4 zero-bar symbols; either add them to the Massive re-fetch or remove them from `universe_symbol`. |
| 4 | Finding 4 | Confirm with data-source documentation whether prices are split-adjusted; document the answer in `docs/10-populating-the-database.md`. |
