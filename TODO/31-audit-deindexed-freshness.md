# 31 — Index-gate the audit's freshness checks for deindexed symbols

> **Status:** in review ([PR #89](https://github.com/kgheacock/tickr/pull/89)) • **Depends on:** 19, 25, 28
>
> **Delivered:** [PR #89](https://github.com/kgheacock/tickr/pull/89) —
> `apps/api/src/audit/run-audit.ts`, `scripts/data-audit.ts`,
> `apps/api/test/audit/run-audit.integration.test.ts`.

## Goal

Stop a symbol that has been **deindexed** from the universe (`removed_at` set)
from blocking a deploy on its own, now-expected, staleness. A deindexed symbol
stops being ingested, so its coverage naturally stops advancing — that is churn,
not data loss, and must not be a deploy-blocking error.

## Background — the incident

The pre-deploy data audit (`scripts/data-audit.ts`, item [19](19-data-audit.md))
aborted a production deploy at the audit stage. Root cause: the **2026-06-11
S&P universe refresh deindexed 46 symbols** (`removed_at` set) but left them
`backfilled = true, data_status = 'ok'`. Ingestion stopped fetching them, so
their bars froze (last bars June 8–9) while the rest of the fleet stayed current
through June 12.

The audit's "playable corpus" only excluded `data_status = 'incomplete'`, **not**
deindexed symbols — so those 46 were still audited as live and tripped
`COVERAGE_GAP` errors on their trailing gaps, blocking the deploy. This is the
same "`removed_at` = deindexed, **not** delisted" semantics that item
[28](28-audit-transition-hardening.md) hardens for *predecessor attribution*;
this item covers the complementary case of a retired symbol's **own** gaps.

## The change

Gate the **freshness/coverage** checks on index membership, while keeping
**integrity** checks universal:

- `COVERAGE_GAP` (trailing/internal), `COVERAGE_REGRESSION`, and `NO_BARS` →
  **warning** (not error) when `removed_at` is set (`detail.deindexed = true`).
- `OHLC_VIOLATION` / `DUPLICATE_BAR` / `no_session_bars` stay **errors** for
  everyone — a retired symbol's retained history is still served, so corruption
  there must still block.
- Ticker-rename transition detection (item 28, `findTransitionPredecessor`) is
  untouched: it keys on the retired *predecessor* of an **active** successor's
  gap, which my early-return (the symbol that *owns* the gap is itself retired)
  does not intercept.

`COVERAGE_REGRESSION` and `NO_BARS` are included beyond the literal trailing-gap
case because they share the root cause: a deindexed symbol's coverage decays as
the rolling audit window slides past its last bar, which would otherwise
re-block a deploy ~3 weeks after deindex.

## Definition of done

- [x] A deindexed symbol's trailing/internal `COVERAGE_GAP` is a **warning**
      (`detail.deindexed = true`); a still-indexed symbol's gap stays an
      **error**. Integration test covers both in one fixture.
- [x] `COVERAGE_REGRESSION` is skipped for a symbol once it is retired (its mark
      is not raised either), so a covered-then-deindexed symbol does not re-block
      a later deploy. Integration test covers the indexed → retired → decay path.
- [x] `NO_BARS` is a **warning** for a retired symbol with zero bars in the
      window (vs. the blocking error a still-indexed zero-bar symbol gets).
- [x] Integrity checks still fire for retired symbols: an `OHLC_VIOLATION` on a
      retired symbol's retained history is still an **error**.
- [x] Verified against a full restore of the prod corpus (2026-06-16 dump): the
      new code drops `symbolsWithErrors` from 70 to **0**, with the deindexed
      cohort and the BK→BNY transition all resolving to warnings.
