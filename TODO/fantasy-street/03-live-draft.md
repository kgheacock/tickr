# FS-03 · Live draft

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 01, 02

## User stories
- As a manager, I want to join a live draft where we take turns picking stocks,
  so that drafting is a shared, social event.
- As a manager, I want a pick timer and a live draft board, so that the draft
  keeps moving and I can see what's been taken.
- As a manager, I want a sensible stock auto-picked for me if I'm offline or
  out of time, so that the draft isn't held up and I'm never left with an empty
  roster.

## Goal

Run a **live, timed snake draft** that turns league members into rostered
teams. The draft is the moment exclusive ownership is created: it writes the
`fs_roster_entry` rows and enforces the **single-owner invariant** for the rest
of the epic. Auto-draft covers offline/expired picks so the draft never stalls.

## Pre-reads
- [Epic README → Locked decisions](README.md#locked-decisions) (live snake,
  timed picks, auto-draft) and [Open question #3](README.md#open-questions-decide-before-building).
- [FS-02](02-players-and-grouping.md) — `fs_player_classification` and the
  `eligibility.ts` helper auto-pick scores against.
- `apps/api/src/ws/` (`server.ts`, `topics.ts`, `subscriber.ts`) and
  `events/publisher.ts` — the live spine the draft board/clock ride on; see
  [16 step 4](../16-platformize-api.md).
- `apps/api/src/jobs/locks.ts` — Redis lock primitive reused for the per-draft
  pick-clock guard.

## Design decisions
- **Pick-clock lives in the `api` process, not cron.** Per-pick timing is
  sub-cron granularity, so the clock is a Redis-backed deadline
  (`fs:draft:{id}:deadline`) advanced by an in-process timer in the `api` role,
  broadcast over WS. A worker cron is unsuitable. (FS-10 auto-managers reuse
  this same advance/auto-pick path.)
- **Single-owner invariant** — `UNIQUE (league_id, symbol)` on `fs_roster_entry`
  (long or short, never both, per open question #3). Every pick insert is the
  enforcement point; concurrent duplicate picks lose the race with `409`.

## Steps
1. **Schema** — `1700000000008_fs_draft.sql`:
   - `fs_draft` — `id UUID PK`, `league_id`, `status TEXT CHECK (status IN
     ('scheduled','in_progress','complete'))`, `pick_seconds SMALLINT DEFAULT 60`,
     `current_overall_pick INT`, `started_at`, `completed_at`.
   - `fs_draft_pick` — `draft_id`, `overall_pick INT`, `round SMALLINT`,
     `user_id`, `symbol → universe_symbol(symbol)`, `is_short BOOLEAN`,
     `auto BOOLEAN`, `picked_at`, `PRIMARY KEY (draft_id, overall_pick)`.
   - `fs_roster_entry` — **the ownership table.** `league_id`, `user_id`,
     `symbol → universe_symbol(symbol)`, `is_short BOOLEAN DEFAULT false`,
     `acquired_via TEXT CHECK (acquired_via IN ('draft','waiver','trade'))`,
     `acquired_at`, `PRIMARY KEY (league_id, user_id, symbol)`,
     **`UNIQUE (league_id, symbol)`** ← single-owner invariant (FS-02/05/07
     reference this).
2. **Snake order + schedule.** On `POST /leagues/:id/draft` (commissioner) with
   league `forming` and full: compute the snake order (1..N, N..1, …) over
   `total_rounds = slots + bench`, set league `status='drafting'`,
   `fs_draft.status='scheduled'`. Publish a draft-start WS event (FS-11 reminder
   hooks here).
3. **Start + clock.** `POST /leagues/:id/draft/start` flips `in_progress`, sets
   `current_overall_pick=1`, writes the Redis deadline, and arms the in-process
   timer. On each tick/pick, recompute whose turn it is from the snake order.
4. **Make a pick.** `POST /leagues/:id/draft/pick` `{ symbol, isShort }` — only
   the on-the-clock user. In one txn: validate the symbol is tradeable, eligible
   for *some* unfilled slot (`eligibility.ts`), and unowned; insert
   `fs_draft_pick` + `fs_roster_entry`; advance `current_overall_pick`; reset the
   deadline. `UNIQUE (league_id, symbol)` violation → `409 ALREADY_OWNED`.
5. **Auto-pick** (`apps/api/src/fantasy/autodraft.ts`). On deadline expiry (or
   for a flagged auto-manager), pick **best-available-by-need**: the highest-
   ranked unowned symbol that fills the team's most-needed unfilled slot, per
   FS-02 classification + eligibility. Writes with `auto=true`. Reused by FS-10.
6. **Live board (WS).** Add topic `{ kind: 'draft'; leagueId }` to
   `ws/topics.ts` + `shared-types/ws.ts`. Publish `draft.pick`, `draft.onClock`
   (with `deadline`), and `draft.complete` via `events/publisher.ts`.
7. **Completion.** When the final pick lands, set `fs_draft.status='complete'`,
   league `status='active'`, and publish `draft.complete`. **FS-06 listens for
   this to generate the season schedule.**
8. **Tests.** Snake order correctness; on-the-clock enforcement; duplicate-pick
   race → `409`; auto-pick respects eligibility/need and never leaves an empty
   roster; deadline expiry triggers auto-pick and advances.

## Files
- Create: `apps/api/migrations/1700000000008_fs_draft.sql`,
  `apps/api/src/fantasy/draft.ts` (orchestration + clock),
  `apps/api/src/fantasy/autodraft.ts`, `routes/leagues/draft.ts`,
  `apps/api/test/fantasy/draft.test.ts`,
  `apps/api/test/fantasy/autodraft.test.ts`.
- Edit: `apps/api/src/ws/topics.ts`, `events/publisher.ts`,
  `packages/shared-types/src/ws.ts` + `fantasy.ts`,
  `apps/api/src/routes/leagues/index.ts`.

## Definition of done
- [ ] A full league starts a draft; turn order follows snake; each user sees the
      board and clock update live over WS.
- [ ] A pick writes both `fs_draft_pick` and `fs_roster_entry`; a second manager
      cannot draft the same symbol (`409`), long or short.
- [ ] When the clock expires, the on-the-clock manager is auto-picked a legal,
      need-appropriate stock; no roster ends with an empty mandatory slot.
- [ ] On the final pick, the draft completes, the league flips to `active`, and
      `draft.complete` is published for FS-06.
