# 12 — Data Remediation Plan

Remediation plan for the findings recorded in
[`docs/11-data-audit-findings.md`](./11-data-audit-findings.md) (audit run
2026-06-08). This document is the *how* and *in what order*; the audit is the
*what*. Read them together.

The audit already lists a per-finding "Fix" and a flat priority table. This plan
does not restate those. It adds the three things the audit does not contain:

1. **A shared root-cause defect** (`backfillSymbol` marks `backfilled = true`
   even when every window returned zero bars) that *masks* several findings and
   will make them silently recur if we re-run the backfill before fixing it.
2. **A gap in the existing re-arm tooling** — `resetSymbolsMissingHistory`
   (`apps/api/src/jobs/widen-history.ts`) only inspects `MIN(ts)`, so the
   automated widen step in `pnpm backfill` will **not** re-arm the symbols in
   Findings 2B/2C.
3. **Two of the audit's proposed fixes are likely no-ops** (Finding 5's
   `adjusted=true`, and parts of Finding 1) — verify before spending effort on
   them. Conversely, one defect the audit did *not* catch (a `limit=5000`
   truncation) may be a real contributor to 2C.

---

## Categorization

Re-grouping the eight findings by *what kind of work each needs* (clearer than a
flat priority list):

| Class | Findings | Nature |
|---|---|---|
| **Code defect** (fix before re-running) | Shared root cause; 2C contributor (`limit`) | Backfill marks symbols complete on empty/truncated windows |
| **Data gap** (re-fetch needed) | 2A, 2B, 2C, 4 | Data missing in our store; some exists at Massive, some may not |
| **Audit tuning** (not a data defect) | 1 | Gap check reaches into sparse post-market zone |
| **Verify-then-likely-no-op** | 5 | Stored prices are already split-adjusted |
| **Self-resolving** | 3 | In-progress backfill; clears on completion |

---

## The shared root cause — fix this first

`backfillSymbol` in `apps/api/src/jobs/backfill.ts:71-104` loops windows and,
for each, inserts bars when `results.length > 0` and logs `window no_data`
otherwise (lines 88-99). **After the loop it unconditionally sets
`backfilled = true`** (lines 101-104) regardless of whether *any* window
returned bars.

This single behavior masks three findings:

- **Finding 4** (MOG-A, BRK-B, FLT — `NO_BARS`): every window returns empty
  (wrong ticker format / delisted), yet the symbol is marked complete.
- **Finding 2C** (near-zero coverage): only the first few windows return data,
  later windows are empty, symbol marked complete with ~2 weeks of history.
- **Finding 2B** (one-year-only): less about this defect — the data *exists* at
  Massive and simply wasn't requested under the old 365-day lookback. Re-running
  with the current 730-day lookback fetches it.

**Why ordering matters:** if we reset `backfilled = false` and re-run *before*
fixing the masking logic, the 2C- and Finding-4-class symbols will once again
mark themselves complete on empty windows, and the defect silently recurs. Fix
the masking first.

### Proposed code change (backfill.ts)

Track whether the symbol produced *any* bars across its windows. Only mark it
fully `backfilled = true` if it did; otherwise leave it `false` (so it stays in
the queue / surfaces in the audit) or set a distinct "no data available" state
(see schema change below).

```
let totalBars = 0;
// ... inside the window loop, on insert:
totalBars += results.length;
// ... after the loop:
if (totalBars === 0) {
  log('warn', 'symbol produced no bars — not marking backfilled', { symbol });
  // leave backfilled = false, OR set data_status = 'no_data' (see below)
  return;
}
```

Optionally also guard against *partial* coverage (a symbol where most windows
were empty) — but that is better handled by the audit + density check than by
in-job heuristics, so keep the job change minimal: "zero bars ⇒ don't mark
complete."

### Schema option (recommended)

The boolean `backfilled` cannot distinguish "done, has data" from "done, no data
available from source" (Finding 4 FLT) from "in progress." Add a nullable status
column so symbols that genuinely have no source data don't get re-queued forever
and can be excluded from game sessions:

```sql
ALTER TABLE universe_symbol
  ADD COLUMN data_status TEXT;          -- NULL | 'ok' | 'no_data' | 'incomplete'
```

(New migration, next number after `1700000000004_etf.sql`.) This directly
supports the audit's Finding 2C interim fix — "flag affected symbols to prevent
them from being used in game sessions" — and Finding 4's FLT disposition.

---

## The `widen-history` gap (re-arm tooling)

The audit's fixes for 2B and 2C say "reset `backfilled = false`, then re-run."
The automated re-arm step in `pnpm backfill` (`resetSymbolsMissingHistory`,
`apps/api/src/jobs/widen-history.ts:32-66`) **will not do this for 2B/2C**: its
`UPDATE … WHERE cov.oldest > $start + threshold` only checks the *oldest* bar
(`MIN(ts)`). 

- **2B** symbols have a correct `MIN(ts)` (mid-2024) but a stale `MAX(ts)`
  (mid-2025) — the widen check ignores `MAX(ts)`, so they are never re-armed.
- **2C** symbols have a correct `MIN(ts)` but only ~13 covered days — the widen
  check ignores density, so they are never re-armed.

So the audit's reset must be done by **explicit SQL** (below) or by **enhancing
`resetSymbolsMissingHistory`** to also re-arm on tail-staleness and low density.

### Explicit reset SQL

2B (stale tail — uses the audit's own query):

```sql
UPDATE universe_symbol SET backfilled = false
WHERE symbol IN (
  SELECT us.symbol
  FROM universe_symbol us
  JOIN price_bar pb ON pb.symbol = us.symbol
  WHERE us.backfilled = true
  GROUP BY us.symbol
  HAVING max(pb.ts) < now() - interval '200 days'
);
```

2C (low density — fewer than ~100 covered trading days over the 2-year window):

```sql
UPDATE universe_symbol SET backfilled = false
WHERE symbol IN (
  SELECT us.symbol
  FROM universe_symbol us
  JOIN price_bar pb ON pb.symbol = us.symbol
  WHERE us.backfilled = true
  GROUP BY us.symbol
  HAVING count(DISTINCT date_trunc('day', pb.ts)) < 100
);
```

> Note: re-running 2C symbols only helps if Massive actually serves their full
> history — see "Verify Massive depth" below. If it does not, mark them
> `data_status = 'incomplete'` instead of looping the reset forever.

### Optional: enhance the widen step

If we want `pnpm backfill` to be self-correcting (no manual SQL), extend
`resetSymbolsMissingHistory` to add tail-staleness and density predicates to its
`UPDATE`. Trade-off: this re-introduces coverage-derivation into a step the
codebase deliberately kept simple (see the caveat comment at
`widen-history.ts:26-31` about IPO-style permanent apparent gaps — a density
check would re-arm genuinely-short-history symbols every run unless paired with
the `data_status` column above to remember "this is all there is").

---

## Verify before doing the work (likely no-ops)

### Finding 5 — split candidates: the audit's fix is a no-op

The audit proposes adding `adjusted=true` to `aggPath()`. **This is already the
default.** Per `apps/api/src/massive/massive.gen.ts:105`, results are
*adjusted for splits by default*, and `backfill.ts:84-87` passes only
`{ sort: 'asc' }` — so stored prices are already split-adjusted.

Reframe Finding 5 as: *why do adjusted series still show ~split-ratio
day-over-day moves?* Most likely **false positives** at the 3%-of-split-factor
threshold (a genuine ±48% single-day move on a volatile small-cap is within 3%
of the 0.5× factor). Confirm by:
- logging the response's own `adjusted` boolean for an affected symbol, and
- eyeballing the three flagged dates against known corporate actions.

If confirmed false positives, **tighten the audit threshold** (e.g. require the
ratio to hold across the close *and* be accompanied by a volume spike), don't
touch `aggPath()`.

### Finding 1 — post-market gaps: audit tuning, not a data fix

Root cause is already understood (audit Finding 1): the gap check's window
(`hour BETWEEN 13 AND 22`) reaches 2 hours past the NYSE close into the sparse
post-market zone. For a regular-session-only v1 this is **not a data defect.**
Resolve by **narrowing the audit's session window to 13:00–20:15 UTC** in
`scripts/data-audit.ts` (regular session + 1 post-close bar). Only pursue the
ingestion-side `extended_hours=false` option if/when extended-hours trading
enters scope.

---

## A defect the audit did not catch — `limit` truncation (2C contributor)

`safeWindowDays` (`apps/api/src/jobs/granularity.ts:51-55`) sizes request windows
against a `RESULT_CAP = 50_000`, on the premise that one request can return up to
50k bars. But the Massive `getAggregates` `limit` parameter **defaults to 5000**
(max 50000) per `massive.gen.ts:109`, and `backfill.ts:84-87` **never passes
`limit`**. So any window expected to yield more than 5000 bars is silently
truncated to the first 5000 (sort=asc), leaving a gap for the rest of that
window — and the client does not paginate.

At 15-minute bars (~64 ext-session bars/trading day) a 5000-bar cap is only
~78 trading days, while `safeWindowDays` will hand back windows of ~700 days.
This can manufacture coverage holes independent of any free-tier depth limit and
is a plausible secondary contributor to Finding 2C.

**Fix:** pass `limit: 50000` in the backfill (and intraday-update) `massiveGet`
query, *and/or* lower `RESULT_CAP`/window sizing to match the real per-request
limit so windows never exceed what one request returns. Verify the free tier
honors `limit=50000` first (the probe script `scripts/probe-massive-candles.ts`
already checks pagination/limits — extend it).

---

## Sequenced execution

Do these in order. Steps 1–2 are code; 3 onward are data operations.

1. **Fix the masking defect** (`backfill.ts`): zero-bar symbols are not marked
   `backfilled = true`. Add the `data_status` migration if adopting the schema
   option. *(Blocks everything below — without it, 2C/4 recur.)*
2. **Fix the `limit` truncation** (`backfill.ts` / `granularity.ts`): pass
   `limit: 50000` or right-size windows. Verify free-tier honors it via the
   probe script.
3. **Finding 4 — ticker format** (MOG-A→MOG.A, BRK-B→BRK.B): update
   `universe_symbol.symbol` (and `data/sp500.csv` seed so it survives re-seed),
   reset `backfilled = false`, re-run.
4. **Finding 4 — FLT**: remove from universe, or replace with CPAY. If kept as
   "no data," let step 1's logic mark it `data_status = 'no_data'`.
5. **Finding 2B**: run the stale-tail reset SQL; re-run backfill (now with the
   730-day lookback + fixed limit).
6. **Verify Massive depth for 2C** (below), then either reset+re-run the 2C
   symbols or mark them `data_status = 'incomplete'`.
7. **Finding 2A** (trailing gap): re-run backfill after the current run
   finishes; the `intraday-update` job maintains the most recent 4 days ongoing.
8. **Finding 1** — *done.* The audit now filters intraday-gap checks to the
   NYSE regular session (09:30–16:00 ET, DST-correct via `AT TIME ZONE
   'America/New_York'`) instead of the old `BETWEEN 13 AND 22` UTC window, so
   the sparse pre/post-market bars no longer register as gaps. Tunable via
   `AUDIT_SESSION_OPEN_ET` / `AUDIT_SESSION_CLOSE_ET`.
9. **Finding 5** — *partly done.* The `SPLIT_CANDIDATE` note now states that
   Massive returns adjusted prices by default (candidates are large moves or
   data errors, not unadjusted splits). Still verify the three flagged dates
   against corporate actions; tighten the tolerance only if they're confirmed
   false positives.
10. **Finding 3**: no action — self-resolves when the run completes.

### Audit-quality changes already applied (`apps/api/src/audit/run-audit.ts`)

These improve the *next* audit run's signal regardless of the data fixes above:

- **Regular-session gap window** (Finding 1) — as in step 8; collapses the
  ~471 false-positive `INTRADAY_GAP` errors to genuine in-session gaps.
- **`COVERAGE_GAP` position classification** — each gap is now tagged
  `leading` / `internal` / `trailing`, so the low-severity trailing gap (2A) is
  mechanically distinguishable from a high-severity historical gap (2B/2C)
  without eyeballing dates.
- **Accurate `SPLIT_CANDIDATE` note** (Finding 5) — as in step 9.

### Verify Massive depth (gate for step 6)

Before looping resets on 2C symbols, confirm whether Massive actually serves
their full 2-year history. Use/extend `scripts/probe-massive-candles.ts` against
a representative 2C symbol (e.g. MRO) requesting the full 730-day range in one
window *with `limit=50000`*:
- If it returns ~2 years ⇒ the truncation/empty-window bug was the cause;
  reset + re-run resolves them.
- If it still returns only ~2–3 weeks ⇒ a genuine per-symbol free-tier depth
  limit; mark `data_status = 'incomplete'` and exclude from game sessions
  (record the conclusion in `docs/10-populating-the-database.md`).

---

## Verification (definition of done)

After the steps above, re-run the audit and confirm the counts move:

```bash
pnpm tsx scripts/data-audit.ts
```

Targets for the next audit run:
- `NO_BARS` → 0 (Finding 4 resolved).
- `COVERAGE_GAP` 2B → 0 (re-fetched); 2C → 0 *or* symbols flagged
  `data_status = 'incomplete'` and excluded from the audit's error count.
- `NOT_BACKFILLED` → 0 once the run completes (Finding 3).
- `INTRADAY_GAP` → drops sharply once the audit session window is narrowed
  (Finding 1); any residual should be regular-session gaps worth investigating.
- `SPLIT_CANDIDATE` → resolved or reclassified as tuned-out false positives.

Re-run is safe to repeat: `insertBars` uses `ON CONFLICT (symbol, ts) DO
NOTHING`, so all re-fetches are idempotent (audit Finding `DUPLICATE_BAR: 0`).
