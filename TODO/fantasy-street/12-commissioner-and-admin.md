# FS-12 · Commissioner & admin tools

**Status:** `done` ([#81](https://github.com/kgheacock/tickr/pull/81)) · **Epic:** [Fantasy Street](README.md) · **Depends on:** 01

## User stories
- As a commissioner, I want to manage settings, resolve scoring disputes, and
  advance the season, so that I can keep the league fair and running.

## Goal

Give commissioners the **operational controls** to run a league mid-season:
edit settings the FS-01 lifecycle locks after `forming`, resolve scoring
disputes by triggering a re-score, force-advance the season, and manage members.
Cross-cutting — **extend the existing admin surface** rather than build a new
one.

## Pre-reads
- [FS-01](01-leagues-and-membership.md) — `requireCommissioner` guard and the
  settings that lock once the draft starts (this item adds the mid-season
  override path).
- [FS-05](05-scoring-and-shorting.md) / [FS-06](06-matchups-and-standings.md) —
  the idempotent re-score + re-settle path a dispute resolution triggers.
- `apps/api/src/routes/admin/` (`ops.ts`, `universe.ts`, `logs.ts`) and the
  platform `admin` role gate — the surface to extend, not replace.
- `apps/api/src/audit/` — the existing audit trail; commissioner actions are
  logged here.

## Design decisions
- **Two authority levels.** Per-league **commissioner** actions are gated by
  `requireCommissioner` (FS-01). Platform **admin** actions (cross-league
  inspection, force-delete) extend `routes/admin/` and the existing `admin` role.
- **Disputes resolve through the normal pipeline.** A commissioner does not edit
  scores by hand; they trigger the FS-05 re-score (idempotent) which re-settles
  matchups and re-ranks standings (FS-06) — keeping results reproducible.
- **All commissioner mutations are audited** via the existing `audit/` trail.

## Steps
1. **Mid-season settings.** `PATCH /leagues/:id/settings` (commissioner) for the
   subset safe to change after `forming` (team names, pick timer for a future
   draft, waiver mode, notification cadence). Structural settings (size, roster
   slots) stay locked once `drafting`; changing them requires the season-reset
   path (FS-08 new season).
2. **Member management.** `DELETE /leagues/:id/members/:userId` (remove before
   draft / replace with a bot via FS-10), `PATCH …/members/:userId` (rename team,
   transfer commissioner role).
3. **Dispute resolution.** `POST /leagues/:id/admin/rescore` `{ week }` —
   re-runs FS-05 scoring for the week (idempotent upsert), which fires the FS-06
   re-settle + standings rebuild. Logged with the commissioner and reason.
4. **Force-advance.** `POST /leagues/:id/admin/advance` — settle/close the
   current week or force the regular→playoffs transition (FS-08) when a week is
   stuck (e.g. a data gap). Guarded and audited.
5. **Manual lineup/lock override.** `POST /leagues/:id/admin/lineup/:userId` —
   set or unlock a manager's lineup in exceptional cases (e.g. lock-job miss).
6. **Platform admin view.** Extend `routes/admin/ops.ts` with FS health: leagues
   by status, drafts in progress, last scoring run per league, stuck weeks —
   reusing the ops/metrics pattern from item 10.
7. **Audit + tests.** Every commissioner/admin mutation writes an `audit/` entry;
   re-score reproduces identical scores for unchanged inputs; non-commissioners
   are rejected (`403`); structural edits are rejected post-draft.

## Files
- Create: `apps/api/src/routes/leagues/admin.ts` (commissioner tools),
  `apps/api/test/fantasy/commissioner.test.ts`.
- Edit: `apps/api/src/routes/admin/ops.ts` (FS health panel),
  `apps/api/src/fantasy/score.ts` / `settle.ts` (expose re-score entry points),
  `apps/api/src/routes/leagues/settings.ts`,
  `apps/api/src/routes/leagues/index.ts`,
  `packages/shared-types/src/fantasy.ts`,
  `apps/web/src/features/fantasy/` (commissioner panel).

## Definition of done
- [x] A commissioner edits the mid-season-safe settings; structural settings are
      rejected once the draft has started.
- [x] A commissioner removes/replaces a member and can transfer the commissioner
      role.
- [x] A dispute re-score for a week re-runs FS-05 → re-settles FS-06 matchups →
      re-ranks standings, reproducibly; a non-commissioner is rejected.
- [x] Force-advance unblocks a stuck week / forces the playoff transition.
- [x] Every commissioner/admin action is recorded in the audit trail; the admin
      ops view shows per-league FS health.

## Completion notes (PR #81)
- Endpoints land under `routes/leagues/admin.ts`; domain logic in
  `fantasy/admin.ts` + the audit trail in `fantasy/audit.ts` (migration
  `1700000000023_fs_audit.sql` → `fs_audit_log`). Ops health is added to
  `routes/admin/ops.ts` via `fantasyHealth()`.
- Re-score anchors default to mirror the scheduler's live-week inputs exactly
  (`nyseRegularCloseAnchor(currentFriday(now))` + −7d baseline), so a live-week
  re-score reproduces identical scores; explicit anchors are accepted for a
  historical dispute. `currentFriday` was lifted into `market/holidays.ts`.
- **Mid-season-safe subset = name + join policy.** The spec floated pick timer /
  waiver mode / notification cadence, but `fs_league` has no such columns;
  adding them would be FS-03/07/11 scope creep, so they're out. Structural
  edits (size, roster, season length) stay forming-only.
- **Web commissioner panel deferred** to a follow-up. The DoD is entirely
  API/audit/ops and is fully met; the endpoints + `@tickr/shared-types` types
  are in place for the panel. Tracked for a later FS UI pass.
- Tests: `apps/api/test/fantasy/commissioner.test.ts` (21).
