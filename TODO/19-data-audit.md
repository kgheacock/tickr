# 19 — Data audit

> **Status:** pending • **Depends on:** 06, 13, 14

## Goal

Verify that the price-bar corpus is complete and consistent before the first
production deployment. A deployment on dirty or gapped data silently produces
wrong returns everywhere downstream.

## Pre-reads

- [06-backfill-and-daily-price.md](06-backfill-and-daily-price.md) — ingestion
  pipelines whose output this audits.
- [13-massive-client.md](13-massive-client.md), [14-kaggle-client.md](14-kaggle-client.md)
  — the two data sources.
- [docs/02-data-model.md](../docs/02-data-model.md) — `price_bar` and
  `universe_symbol` schemas.

## Steps

1. **Coverage check.** For each `universe_symbol`, assert that `price_bar`
   rows exist from the expected start date through the latest trading day.
   Report symbols with no bars, bars only before some cutoff, or large gaps
   (configurable threshold, default 5 consecutive trading days).
2. **OHLC sanity.** Assert `low ≤ open, close ≤ high` and `volume ≥ 0` for
   every row. Flag violations.
3. **Duplicate detection.** Assert unique `(symbol, bar_time)` within the
   expected granularity. Duplicates indicate a double-ingest bug.
4. **Cross-source reconciliation.** For symbols present in both Massive and
   Kaggle, compare closing prices on overlapping dates. Surface deviations
   above a configurable threshold (e.g. 1%).
5. **Report.** Emit a structured JSON report: total symbols, symbols clean,
   symbols with warnings, symbols with errors, and per-symbol detail for any
   flagged rows. Print a human-readable summary to stdout. Exit non-zero if
   any errors are found.
6. **CI gate.** Wire the audit script into the deployment runbook (item 12) so
   it runs before any production migration and blocks on error.

## Files

- Create: `scripts/data-audit.ts` (runnable via `pnpm tsx`)
- Edit: `TODO/12-deployment.md` — add audit step to the pre-deploy checklist.

## Definition of done

- [ ] `pnpm tsx scripts/data-audit.ts` exits 0 on a clean corpus and non-zero
      on a seeded corpus with known violations.
- [ ] Coverage gaps, OHLC violations, duplicates, and cross-source deviations
      each produce a distinct error code in the report.
- [ ] The deployment runbook (item 12) references this script as a required
      pre-deploy step.
