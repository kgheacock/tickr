# FS-04 · Rosters & weekly lineups

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 03

## User stories
- As a manager, I want to set my starting lineup each week from my roster, so
  that I decide who plays.
- As a manager, I want my lineup to lock when the market opens Monday, so that
  everyone commits before the week plays out.
- As a manager, I want any slot I forget to set to be auto-filled with my best
  option, so that I never field an empty slot.
- As a manager, I want only a few bench spots, so that start/sit choices are
  meaningful commitments rather than free insurance.

## Goal

Let managers set a **weekly starting lineup** from their drafted roster, **lock
it Monday at market open**, and **auto-fill** any unset slot so no one fields an
empty position. This produces the frozen, started set of (symbol, slot, isShort)
that FS-05 scores.

## Pre-reads
- [Epic README → Locked decisions](README.md#locked-decisions) — Monday-open
  lock, mandatory fixed slots + auto-fill, shallow bench.
- [FS-03](03-live-draft.md) — `fs_roster_entry` (the roster) and the `is_short`
  flag a Defense pick carries into its slot.
- [FS-02](02-players-and-grouping.md) — `eligibility.ts` (`isEligible(symbol,
  slot)`) used for slot placement and auto-fill.
- `apps/api/src/jobs/scheduler.ts`, `jobs/locks.ts`, `market/holidays.ts` — the
  cron + lock + NYSE-calendar machinery the lock job reuses.

## Design decisions
- **Week numbering** — `week SMALLINT` is league-relative (1..`season_length_weeks`),
  derived from the season schedule (FS-06). Lineups carry `season SMALLINT
  DEFAULT 1` so FS-08's season lifecycle is additive.
- **Lock cadence** — a Monday cron at **market open (~14:30 UTC)**, holiday-aware
  via `isNyseHoliday`. Lock freezes the lineup for the whole scoring week; edits
  after lock are rejected.
- **Defense slot** is filled only by an `is_short` roster entry; long slots only
  by non-short entries (the flag is fixed at draft/acquire time).

## Steps
1. **Schema** — `1700000000009_fs_lineups.sql`:
   - `fs_lineup` — `id UUID PK`, `league_id`, `user_id`, `season SMALLINT`,
     `week SMALLINT`, `locked_at TIMESTAMPTZ`, `auto_filled BOOLEAN DEFAULT false`,
     `UNIQUE (league_id, user_id, season, week)`.
   - `fs_lineup_slot` — `lineup_id → fs_lineup(id) ON DELETE CASCADE`,
     `slot TEXT CHECK (slot IN ('anchor','growth','momentum','value','defense','wildcard','bench'))`,
     `slot_index SMALLINT` (for the bench/duplicate slots), `symbol`,
     `is_short BOOLEAN`, `PRIMARY KEY (lineup_id, slot, slot_index)`.
2. **Get/initialize current lineup.** `GET /leagues/:id/lineup?week=` returns the
   manager's lineup for the week, creating an empty (carry-forward from prior
   week where legal) draft if none exists and the week is unlocked.
3. **Set lineup.** `PUT /leagues/:id/lineup` `{ week, slots: [{slot, slotIndex,
   symbol}] }` — validates: every symbol is on the caller's `fs_roster_entry`,
   each placement is `isEligible(symbol, slot)`, Defense holds a short and long
   slots hold longs, no symbol is started twice, all mandatory slots present or
   left for auto-fill. Rejects if the week is locked (`409 LINEUP_LOCKED`).
4. **Auto-fill** (`apps/api/src/fantasy/autofill.ts`) — fills each empty
   mandatory slot with the manager's best eligible bench/roster option (best by
   FS-02 recent-return rank, respecting short/long). Shared logic invoked both
   on explicit "auto-fill remaining" and by the lock job.
5. **Lock job** (`apps/api/src/fantasy/lock.ts`, run from `jobs/scheduler.ts`) —
   Monday market-open cron under a Redis lock: for every `active` league and
   every manager, run auto-fill on any incomplete lineup, stamp `locked_at`, set
   `auto_filled` where applicable. Publishes a `lineup.locked` event (FS-09/11).
6. **Bench depth** — enforce the league `roster_config` bench count; reject
   `PUT` lineups that exceed mandatory-slot counts or under-fill the bench bound.
7. **Tests.** Eligibility + short/long placement rules; double-start rejection;
   lock-after edit rejection; auto-fill leaves no empty mandatory slot and
   respects short/long; holiday Monday defers correctly.

## Files
- Create: `apps/api/migrations/1700000000009_fs_lineups.sql`,
  `apps/api/src/fantasy/autofill.ts`, `fantasy/lock.ts`,
  `apps/api/src/routes/leagues/lineup.ts`,
  `apps/api/test/fantasy/lineup.test.ts`, `test/fantasy/autofill.test.ts`.
- Edit: `apps/api/src/jobs/scheduler.ts` (Monday lock cron),
  `events/publisher.ts`, `apps/api/src/routes/leagues/index.ts`,
  `packages/shared-types/src/fantasy.ts`.

## Definition of done
- [ ] A manager sets a valid lineup; ineligible placements, double-starts, and
      a long in the Defense slot are all rejected.
- [ ] At Monday market open the lock job freezes every league's lineups and
      auto-fills incomplete ones; a post-lock edit is rejected.
- [ ] An untouched manager is auto-filled to a complete, legal lineup (no empty
      mandatory slot) and flagged `auto_filled`.
- [ ] A holiday Monday does not lock; lock occurs on the correct open.
- [ ] The locked, started set is queryable by FS-05 for scoring.
