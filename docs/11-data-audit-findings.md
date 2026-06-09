# 11 — Data Audit Findings

This document is updated in place as each backfill run is audited. Each section records when a finding was first observed and what the current status is.

---

## Audit run: 2026-06-08 (current)

> Script: `pnpm tsx scripts/data-audit.ts`
> Window: 2024-06-09 → 2026-06-08 (730 days, 15-minute granularity)
> Backfill status at time of audit: **64% complete** (313/492 done, ~2 h remaining)

| Metric | Count |
|---|---|
| Total symbols | 492 |
| Clean | 7 |
| Warnings only | 7 |
| Errors | 478 |

| Code | Count | Severity |
|---|---|---|
| `INTRADAY_GAP` | 471 | error |
| `COVERAGE_GAP` | 189 | error |
| `NOT_BACKFILLED` | 183 | warning/error† |
| `NO_BARS` | 3 | error |
| `SPLIT_CANDIDATE` | 3 | warning |
| `OHLC_VIOLATION` | 0 | — |
| `DUPLICATE_BAR` | 0 | — |
| `CROSS_SOURCE_DEVIATION` | 0 | — |

† `NOT_BACKFILLED` is emitted as a warning; if the symbol also has partial bars with post-market gaps it gets escalated to error (see Finding 1).

---

## Finding 1 — `INTRADAY_GAP: session_gap` (471 symbols)

**Severity:** Error per audit, but **does not block regular-session functionality.**

### What the audit saw

471 of 492 symbols have at least one intraday gap exceeding the 30-minute threshold. Reported `maxGapMinutes` range from 45 to 165. The `gapCount` per symbol is typically 2–25.

### Root cause

All detected gaps occur in the **post-market extended hours** (20:00–22:xx UTC = 4:00–6:xx PM ET), not during the NYSE regular session.

Confirmed by querying the exact gap timestamps for representative symbols:

| Symbol | Gap timestamp (UTC) | Gap (min) | In ET |
|---|---|---|---|
| A | 2024-06-11T20:30:00Z | 45 | 4:30 PM EDT (post-close) |
| A | 2024-06-21T20:45:00Z | 45 | 4:45 PM EDT (post-close) |
| A | 2025-06-09T20:15:00Z | 105 | 4:15 PM EDT (post-close) |

The regular session (9:30 AM – 4:00 PM ET = 13:30–20:00 UTC in EDT, 14:30–21:00 UTC in EST) has continuous 15-minute bars with no gaps. Example: symbol A shows 29–35 bars per trading day from 04:00 UTC (midnight ET) to ~20:30 UTC, with the regular session portion (13:30–20:00 UTC) fully populated.

The Massive API returns sparse post-market data: after the NYSE 4:00 PM close, bars are returned at irregular intervals (some sessions have 15-minute spacing, others have 45–165-minute gaps). The audit's session window is `EXTRACT(hour FROM ts AT TIME ZONE 'UTC') BETWEEN 13 AND 22`, which extends 2 hours past close into this sparse post-market zone.

### Impact

Regular session data is clean. This finding does not affect game mechanics that are restricted to market hours (9:30 AM – 4:00 PM ET). If extended-hours trading is added in a future version, the post-market data gaps would need to be addressed.

The 7 clean symbols have no post-market gaps exceeding 30 minutes, either because Massive returned continuous post-market data for them or they had no post-market activity in the audit window.

### Options to resolve

1. **Narrow the audit session window** to 13:00–20:15 UTC (regular session + 1 bar of post-close buffer). This eliminates the post-market zone from the gap check and is the most accurate definition of "session."
2. **Accept as expected** if extended-hours trading is out of scope for v1. Document the sparse post-market data as a known data-source characteristic.
3. **Filter extended-hours bars** at ingestion time to avoid storing them altogether (changes `aggPath` to add `extended_hours=false` if the Massive API supports it).

---

## Finding 2 — `COVERAGE_GAP` (189 instances)

**Severity:** Error — varies by sub-type (see below).

### Sub-type A: Trailing 5–10 day gap (~30 symbols, low severity)

Symbols that were backfilled before the most recent trading week are missing the last 5–10 trading days. Example: AAPL is missing 2026-06-01 to 2026-06-08 (6 trading days).

**Cause:** The backfill job fetches up to `now` at the moment the symbol is processed. Symbols processed 1–2 weeks ago have a trailing gap. The `intraday-update.ts` session-update job (SESSION_LOOKBACK_DAYS = 4) will close this within one post-close run, but only for the most recent 4 days; a manual backfill re-run may be needed for gaps of 5–10 days.

**Fix:** Run `pnpm backfill` again after the current run completes; the session-update job handles ongoing maintenance.

### Sub-type B: Historical year gap (~237–239 trading days, ~60 symbols, high severity)

Symbols like CAT (gap 2025-06-27 to 2026-06-08, 238 days) and CCI (2025-06-27 to 2026-06-08, 238 days) have data for only one of the expected two years. The missing range is always approximately the second year (mid-2025 to mid-2026).

**Cause:** A prior backfill run used a 1-year lookback (BACKFILL_LOOKBACK_DAYS=365). Those symbols were marked `backfilled = true` with only 1 year of history. The current run uses a 2-year lookback, but these symbols are already marked `backfilled = true` and are therefore excluded from the current queue (`WHERE backfilled = false`).

**Fix:** Reset `backfilled = false` for affected symbols in the database, then run `pnpm backfill`. Affected symbols can be identified by querying:

```sql
SELECT us.symbol
FROM universe_symbol us
JOIN price_bar pb ON pb.symbol = us.symbol
WHERE us.backfilled = true
GROUP BY us.symbol
HAVING max(pb.ts) < now() - interval '200 days';
```

### Sub-type C: Near-zero historical coverage (~100 symbols, high severity)

123 backfilled symbols have fewer than 100 covered trading days despite being marked `backfilled = true`. Example: MRO has only 13 covered days (2024-06-10 to 2024-06-27). Other examples include MU (16 days), OXY (18 days), META (19 days), NCLH, NKE, MRNA, NEM, LULU, LEN.

**Cause:** The Massive free tier appears to have per-symbol data depth limits for certain tickers. For these symbols, a single 365-day window request returned bars for only the first 2–3 weeks of the requested range, and subsequent windows for later periods returned empty results. The backfill job treats empty windows as successfully processed and marks the symbol `backfilled = true`, masking the sparse coverage.

These symbols require investigation to determine whether:
- The free-tier plan covers the full historical depth (2 years), or
- An upgraded plan or alternative data source is needed for these specific tickers.

**Fix:** Requires root-cause investigation with the Massive API. As an interim measure, identify these symbols and flag them as data-incomplete in `universe_symbol` to prevent them from being used in game sessions.

---

## Finding 3 — `NOT_BACKFILLED` (183 symbols)

**Severity:** Warning — in-progress backfill, not a data quality defect.

### What the audit saw

183 symbols in `universe_symbol` have `backfilled = false`. These are the symbols queued but not yet processed by the current backfill run.

### Root cause

The backfill job processes symbols concurrently (CONCURRENCY = 4, default). At the time of this audit, 313 of 492 symbols had been processed (64%), with an ETA of approximately 2 hours. This finding resolves itself when the current run completes.

Of the 183, approximately 176 also carry an `INTRADAY_GAP` error because they have partial bars from previous backfill attempts with post-market gaps. The 7 symbols with warning-only status have no prior bars at all.

### Fix

No action required. The finding will clear when the current `pnpm backfill` run finishes and the audit is re-run.

---

## Finding 4 — `NO_BARS` (3 symbols: MOG-A, BRK-B, FLT)

**Severity:** Error.

### What the audit saw

Three symbols are marked `backfilled = true` but have zero rows in `price_bar`.

### Root cause

**MOG-A, BRK-B** — Ticker format mismatch. The `universe_symbol` table stores these with hyphens (`MOG-A`, `BRK-B`). The Massive API uses period notation for share-class suffixes (`MOG.A`, `BRK.B`). The `aggPath()` function builds the URL literally, so both requests return 0 results. The backfill loop treats an empty window as `no_data` (not an error) and marks the symbol `backfilled = true` after all windows complete.

**FLT** — Delisted ticker. FleetCor Technologies rebranded and moved to a new ticker (CPAY) in 2024. The Massive API has no data for `FLT` in the audit window (2024-06-09 onward) and the same empty-window logic applies.

### Fix

1. Update `universe_symbol.symbol` for the two hyphenated tickers to the period format used by Massive (`MOG.A`, `BRK.B`), then reset `backfilled = false` and re-run.
2. Evaluate `FLT`: either remove it from the universe or replace it with the current ticker (`CPAY`). If `CPAY` is added, the `universe_symbol.backfilled` migration script should handle it.

---

## Finding 5 — `SPLIT_CANDIDATE` (3 symbols, warning)

**Severity:** Warning — requires verification, does not block deployment for regular-session-only v1.

### What the audit saw

Three symbols have a consecutive-day close ratio within 3% of a common split factor (0.5× = 2:1 forward split, or 2.0× = 1:2 reverse split) at some point in the 2-year window.

### Root cause

Unchanged from prior audit. The Massive API response schema includes an `adjusted` field on `AggregatesResponse` (`massive.gen.ts`), but the ingestion path does not inspect or log this flag. If the source serves unadjusted prices and a split occurred during the coverage window, the price series will have a step discontinuity on the split date.

### Fix

Confirm with Massive API documentation whether `/v2/aggs` returns split-adjusted or unadjusted prices by default. If unadjusted, add `adjusted=true` to the query parameters in `aggPath()` and re-fetch affected symbols. Document the answer in `docs/10-populating-the-database.md`.

---

## Checks that passed

- **`OHLC_VIOLATION`: 0** — All OHLC relationships are internally consistent (low ≤ open, close ≤ high; volume ≥ 0).
- **`DUPLICATE_BAR`: 0** — No duplicate `(symbol, ts)` entries. The `ON CONFLICT DO NOTHING` in `insertBars.ts` makes re-runs idempotent.
- **`CROSS_SOURCE_DEVIATION`: 0** — No symbols have both a midnight-UTC daily bar and an intraday bar for the same date. The corpus is now entirely sourced from Massive.

---

## Fix priority

| Priority | Finding | Action |
|---|---|---|
| 1 | Finding 4 (MOG-A, BRK-B) | Fix ticker format to period notation; reset `backfilled = false`; re-run backfill. |
| 2 | Finding 4 (FLT) | Remove from universe or replace with CPAY and re-backfill. |
| 3 | Finding 2B (1-year-only symbols) | Run SQL above to identify; reset `backfilled = false`; re-run backfill. |
| 4 | Finding 2C (near-zero coverage) | Investigate Massive free-tier data depth limits; flag affected symbols in `universe_symbol`. |
| 5 | Finding 2A (trailing gap) | Re-run backfill + session-update job after current run finishes. |
| 6 | Finding 3 (in-progress) | Self-resolves. Re-audit after current backfill run completes. |
| 7 | Finding 1 (post-market gaps) | Narrow audit session window to 13:00–20:15 UTC OR add `extended_hours=false` to API call if not using post-market data. |
| 8 | Finding 5 (split candidates) | Verify `adjusted` flag in Massive API docs; update `aggPath()` if needed. |

---

## Prior audit: 2026-06-08 (pre-Massive-backfill)

This section preserves findings from before the Massive backfill was run. The prior Kaggle import produced midnight-UTC daily bars for all 492 symbols, blocking intraday functionality. Those findings are now resolved:

- **Finding 1 (prior): `INTRADAY_GAP: no_session_bars`** — 484 symbols with all bars at `00:00:00Z` (midnight UTC). Caused by the Kaggle import script treating date-only strings as local midnight UTC. **Fixed:** Kaggle client removed; `backfilled = false` reset; Massive backfill running.
- **Finding 2 (prior): `COVERAGE_GAP`** — 549 instances from the Kaggle dataset cutoff. **Partially fixed:** resolves as Massive backfill completes (sub-types B and C above are new issues surfaced by the backfill itself).
- **Finding 3 (prior): `NO_BARS`** — 4 symbols (one has since been resolved). Remaining 3 are documented in Finding 4 above.
