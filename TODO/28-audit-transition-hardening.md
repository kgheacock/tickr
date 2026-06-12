# 28 — Harden the audit's ticker-transition awareness

> **Status:** pending • **Depends on:** 19, 25

## Goal

Close a latent data-loss hole opened by the first transition-aware audit fix
([PR #71](https://github.com/kgheacock/tickr/pull/71), commit `7e7f2f7`). That
change downgrades an **active** symbol's `internal`/`trailing` coverage-gap from
an **error** to a **warning** when a *retired* sibling covers ≥90% of the gap
window — so a renamed ticker (BK → BNY) no longer aborts the deploy. The fix is
correct for the BK→BNY case but the matching rule is far too loose, and it
weakens the audit's single most important guard against silent data loss.

## Background — why the current rule is unsafe

`findTransitionPredecessor` (`apps/api/src/audit/run-audit.ts`) returns the
**first (alphabetical) `removed_at IS NOT NULL` symbol** whose bars cover ≥90%
of the gap window. The flawed assumption is that `removed_at` means *delisted*.
It does not — **`removed_at` means "dropped from the S&P 500 index,"** and most
such symbols still trade with full, current histories.

Measured on prod (2026-06-12):

- `AAL` has `removed_at = 2026-06-11`, `data_status = 'ok'`, and covers **71/71**
  of BNY's gap window — a perfectly healthy still-trading stock.
- Of **63** `removed_at`-set symbols, **47 cover ≥90%** of any recent window.

Consequence: any active symbol's genuine internal/trailing gap gets silently
downgraded to a warning by a coincidental match. BNY's gap was even tagged with
predecessor `AAL` (unrelated) rather than the real predecessor `BK` — the verdict
was correct only by luck. The error path — the audit's main data-loss detector —
is effectively defeatable for almost any active symbol. This is a **latent**
hazard (today's corpus has only one internal gap, BNY, whose downgrade is
substantively right), not a current incident.

## Pre-reads

- [19-data-audit.md](19-data-audit.md) — the audit this hardens.
- [25-universe-from-wikipedia.md](25-universe-from-wikipedia.md) — where
  `removed_at` is set (`apps/api/src/db/seed-universe.ts`) and its
  deindexed-not-delisted semantics.
- `apps/api/src/audit/run-audit.ts` — `findTransitionPredecessor` and the
  coverage-gap classification loop.

## Steps

Three independent layers, sequenced cheapest-and-most-urgent first. Each is
shippable on its own.

### 1. Adjacency filter — restore the guard (cheap, no schema change)

A genuine predecessor *goes dark* when the successor lights up: BK stops trading
at the transition; AAL keeps trading straight through it. Restrict
`findTransitionPredecessor` candidates to retired symbols whose **newest bar
lands at/near the gap** (i.e. the predecessor's history ends where the
successor's gap is) rather than continuing past it. This alone rejects all ~47
still-trading deindexed symbols while keeping BK, and needs no migration.

### 2. Coverage high-water-mark — durable data-loss guard

Persist, per symbol, the best coverage ever observed and flag any **regression**
below it. This keys on the *right* signal — "did **this** symbol lose data it
once had" — rather than "does **some other** symbol have data here." It cleanly
separates the two cases: a genuine loss trips the watermark (→ error); a true
transition like BNY is silent (BNY never had those bars — they live under BK). It
also closes the latent-coupling caveat from PR #71: if BK's bars are ever pruned,
BK's **own** watermark fires.

- New table `symbol_coverage_watermark(symbol, granularity, trading_days,
  oldest_ts, newest_ts, observed_at)`, updated after each successful audit/backfill.
- Audit reports `current < watermark` (beyond tolerance) as an **error**.
- Scope to the audit window / exclude policy-aged data so intentional
  retention/downsampling of old raw bars does not false-positive (historical
  bars are otherwise append-only, so any decrease is genuinely suspicious).

This is **complementary, not a replacement** for attribution: the watermark is
silent on BNY's gap, so the coverage-gap check still needs steps 1/3 to classify
"internal gap present but the symbol never had the data."

### 3. CIK lineage — precise attribution (forward-looking)

Replace the date-coverage heuristic's *guess* with a real same-issuer test. CIK
(SEC issuer id) is stable across renames; BK and BNY share `0001390777`. It is
already present and complete in the Massive `raw` payload we fetch (548/548
active metadata rows have a non-null `cik`) — no new external call.

- Migration: `ALTER TABLE universe_symbol ADD COLUMN cik TEXT;` (nullable).
- `apps/api/src/jobs/refresh-metadata.ts` — write `cik` onto `universe_symbol`
  during the existing metadata upsert, so it **survives retirement** (the
  retired side is exactly where it's missing today: BK has no `symbol_metadata`
  row because the refresh only fetches `removed_at IS NULL`).
- `apps/api/src/audit/run-audit.ts` — match transition candidates by **shared
  CIK** (pair with step 1's adjacency to disambiguate share classes, which share
  a CIK — e.g. GOOG/GOOGL `0001652044`, FOX/FOXA, NWS/NWSA, UA/UAA).
- One-time backfill of `cik` for already-retired transition symbols (set BK =
  `0001390777`); going-forward snapshotting only covers symbols that had
  metadata while active.

Caveat — scope check: CIK identifies the **issuer**, not the **security** (one
CIK → many tickers for dual-class names). It is the right key for *lineage*, not
a replacement primary key for `universe_symbol`/`price_bar`, which are correctly
keyed on the per-security ticker. If ticker-rename FK churn ever becomes a
recurring pain, the proper fix is an internal immutable surrogate `security_id`,
not CIK — track that separately if/when it bites.

## Files

- Create: `apps/api/migrations/0120000000000_universe-cik.sql` (renumber to the
  next free slot) — `universe_symbol.cik`.
- Create: migration + table for `symbol_coverage_watermark`.
- Edit: `apps/api/src/audit/run-audit.ts` — adjacency filter, CIK match,
  watermark regression check.
- Edit: `apps/api/src/jobs/refresh-metadata.ts` — persist `cik`.
- Edit: tests under `apps/api/test/audit/`.

## Definition of done

- [ ] **Step 1:** A still-trading deindexed symbol (`removed_at` set, current
      bars) no longer satisfies `findTransitionPredecessor`; BK still does for
      BNY. Unit test covers the AAL-style rejection.
- [ ] **Step 1:** Re-running the audit on prod data keeps `symbolsWithErrors = 0`
      (BNY still downgrades via BK), with BNY's `transitionPredecessor` now `BK`,
      not `AAL`.
- [ ] **Step 2:** A symbol whose stored coverage drops below its recorded
      high-water-mark produces a distinct regression **error**; a clean re-run
      and the BNY transition do not.
- [ ] **Step 2:** Watermark is scoped so intentional retention/downsampling does
      not false-positive.
- [ ] **Step 3:** `universe_symbol.cik` is populated by the metadata refresh and
      survives a symbol's retirement; BK's CIK is backfilled.
- [ ] **Step 3:** Transition downgrades require a shared CIK; a same-window
      coincidental cover with a *different* CIK stays an **error**.
- [ ] The fail-open behaviour from PR #71 is gone: a missing/ambiguous
      predecessor leaves the gap as an **error** (fail closed).
