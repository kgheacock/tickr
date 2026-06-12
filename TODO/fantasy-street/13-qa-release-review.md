# FS-13 · QA release review — PR #70 (Fantasy Street → `main`)

**Status:** `in-progress` (review open) · **Epic:** [Fantasy Street](README.md)
**Role:** QA release lead · **Reviewed:** 2026-06-11
**PR:** [#70 — Fantasy street](https://github.com/kgheacock/tickr/pull/70)
(`fantasy-street` → `main`, +11,199 / −65, 77 files)

This is the integration PR that lands FS epic items **01–07** (item 00 already
shipped in #48) onto `main`. This file is the single ledger of every deviation
from the definition of done and every correctness/isolation concern found, so a
release decision can be made from one place.

## Verdict

**❌ BLOCK — do not merge/deploy as-is.** One release-blocking defect (F1) aborts
the production migration before any FS table is created. CI is green and a fresh
DB migrates cleanly, so the defect is invisible to the existing pipeline — it
only manifests on the prod *upgrade* path. F1 must be fixed; F2/F3 are
merge-at-discretion with follow-ups.

## Findings

| # | Sev | Finding | Location | PR comment |
|---|-----|---------|----------|------------|
| F1 | 🔴 Blocker | FS migrations `006–010` (+ a duplicate `007`) interleave with platform migrations `007_symbol-metadata` (#67) and `011_universe-dash-to-dot` that already shipped to `main`/prod. `node-pg-migrate` runs with default `checkOrder: true`, which rejects an un-run migration sorting before an already-run one. **Verified:** on a scratch DB at prod's applied state, `db:migrate` throws `Not run migration 1700000000006_fs_leagues is preceding already run migration 1700000000007_symbol-metadata` → deploy aborts. | `apps/api/migrations/1700000000006_fs_leagues.sql` … `010_fs_scores.sql`; duplicate `1700000000007_*`; `apps/api/src/db/migrate.ts` (no `checkOrder:false`) | [discussion_r3399624197](https://github.com/kgheacock/tickr/pull/70#discussion_r3399624197) |
| F2 | 🟡 Isolation | Core platform endpoint `/me` now **unconditionally** calls `getUserLeagues`, hard-joining `fs_league_member`/`fs_league` into every authenticated response. Couples the stock platform login bootstrap to FS schema; an independent FS rollback breaks `/me`. | `apps/api/src/routes/me.ts:29` | [discussion_r3399624261](https://github.com/kgheacock/tickr/pull/70#discussion_r3399624261) |
| F3 | 🟠 Limitation | Automated weekly crons (lineup-lock, weekly-settle, provisional-scoring) are pinned to week 1 via `currentWeek() => 1`. Item 06 builds a multi-week round-robin, but weeks ≥ 2 will never auto-lock/auto-settle until the `TODO(FS-06)` week-derivation lands. | `apps/api/src/jobs/scheduler.ts:42` | [discussion_r3399624310](https://github.com/kgheacock/tickr/pull/70#discussion_r3399624310) |

### F1 — recommended fix (verified)

Renumber the entire FS chain to sort **after** `011`, preserving
`leagues → classification → draft → lineups → scores → matchups → transactions`:

```
1700000000006_fs_leagues        → 1700000000012_fs_leagues
1700000000007_fs_classification → 1700000000013_fs_classification
1700000000008_fs_draft          → 1700000000014_fs_draft
1700000000009_fs_lineups        → 1700000000015_fs_lineups
1700000000010_fs_scores         → 1700000000016_fs_scores
1700000000012_fs_matchups       → 1700000000017_fs_matchups
1700000000013_fs_transactions   → 1700000000018_fs_transactions
```

No later migration carries an FK to `fs_roster_entry` / `fs_player_classification`,
so the move is DDL-safe. Re-running the scratch test with the renumbered set
clears `checkOrder` and begins applying `012_fs_leagues`. This also removes the
duplicate `1700000000007_*` filename. (Renumbering only `fs_classification` does
**not** fix it — the gate trips on `006_fs_leagues`.)

*Assumes no persistent env has already applied the old FS numbers* — true today
given manual-deploy discipline (prod is at `main`'s state; FS has never
deployed). If any env already ran `006–010`, renaming the files would orphan
those `pgmigrations` rows and needs a data-aware reconciliation instead.

## Definition-of-done check (items 01–07)

DoD checklists for 01–07 are internally satisfied and unit-tested (the PR adds
~3,500 lines of `apps/api/test/fantasy/*`). Deviations vs. the epic intent:

- **F3 (item 06)** — schedule/matchup/standings modules + endpoints meet their
  DoD, but the *cron integration* only ever drives week 1. The single-week MVP
  scope must be made explicit, not implicit.
- **Open data item (item 02)** — `value` classification is a price-only proxy;
  sector / market-cap tier is deferred pending a fundamentals feed. Documented in
  the `007_fs_classification` migration, not a regression — noted for tracking.

No DoD item was found falsely checked beyond the above.

## Isolation assessment (platform ↔ FS / parallel features)

Goal: FS must not prevent non-FS platform features from shipping in parallel.

- ✅ **Routes** — FS mounts under `/api/v1/leagues/*` via an additive
  `registerLeaguesRoutes`; no platform route changed.
- ✅ **Realtime** — new WS topics (`draft:*`, `matchup:*`) and Redis channels are
  FS-namespaced (`fs:*`); publisher additions are new functions only.
- ✅ **Jobs** — new crons use distinct `fs:job:*` locks; no platform job altered.
- ✅ **Schema** — all FS tables are `fs_*` prefixed; only FK reuse is `app_user` /
  `universe_symbol` (read-only).
- ⚠️ **F1 (migration numbering)** — the one real isolation breach: FS claimed
  migration numbers a parallel platform feature also used. **Discipline for
  future parallel work: number new migrations strictly greater than the highest
  number on every branch that will reach `main`, never backfill a gap.**
- ⚠️ **F2 (`/me` coupling)** — the only platform endpoint now hard-depending on FS.

## Next actions

- [ ] **F1** — author renumbers FS migration chain after `011`; re-run a
      main-state migration test before re-requesting review. *(blocks merge)*
- [ ] **F2** — make `/me` tolerant of FS absence (or feature-gate the `leagues`
      field).
- [ ] **F3** — confirm single-week MVP scope; open a follow-up for FS-06 week
      derivation.
- [ ] Re-review and flip this item to `done` once F1 is resolved and verified.
