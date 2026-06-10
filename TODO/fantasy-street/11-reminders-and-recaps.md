# FS-11 · Reminders & recaps

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 04, 05, 06

## User stories
- As a manager, I want a reminder each week to set my team before the Monday
  lock, so that I never get auto-filled by accident.
- As a manager, I want a reminder when the draft is about to start, so that I
  don't miss it.
- As a manager, I want a weekly recap of my matchup and the league — final
  scores, biggest movers, notable wins and blowups — so that I can relive the
  week and keep tabs on my rivals.

## Goal

Keep managers engaged with **timely reminders** (set-your-lineup, draft-starting)
and a **weekly recap** (matchup result, biggest movers, blowups) built from the
FS-05 per-slot breakdown and FS-06 results. Delivered in-app via the existing WS
spine + a persisted notification feed; email is deferred.

## Pre-reads
- [FS-05](05-scoring-and-shorting.md) — `fs_weekly_score.breakdown` is the recap
  data source (biggest movers / blowups come from the per-slot points).
- [FS-06](06-matchups-and-standings.md) — settled `fs_matchup` results for the
  recap headline.
- `apps/api/src/alerts/checker.ts` — **pattern reuse only:** cron tick + a Redis
  "fired" flag for once-per-window dedupe. It is an **ops** path (Discord
  webhook), **not** a user-facing channel — do not route manager reminders
  through it (see decision).
- `apps/api/src/jobs/scheduler.ts`, `market/holidays.ts` — cron + NYSE calendar
  for reminder timing.

## Design decisions
- **No user-facing notification channel exists yet.** The platform has WS (live)
  and a Discord ops webhook only. So this item builds a **persisted in-app
  notification feed** (`fs_notification`) surfaced on the FS-09 dashboard and
  pushed live over WS. **Email/push is deferred** (open item — needs a provider;
  none is wired). Reminders therefore = in-app + live, not email.
- **Reuse the alert *pattern*, not the alert *path*** — a worker tick with a
  Redis dedupe flag so a reminder fires once per (league, week, kind), never on
  every tick.
- **Recaps are generated, not live** — one job after the Friday settle composes a
  recap row per manager from FS-05/06 data.

## Steps
1. **Schema** — `1700000000015_fs_notifications.sql`:
   - `fs_notification` — `id`, `league_id`, `user_id`, `kind TEXT CHECK (kind IN
     ('lineup_reminder','draft_reminder','recap'))`, `payload JSONB`,
     `created_at`, `read_at`, index on `(user_id, created_at)`.
2. **Lineup reminder** (`apps/api/src/fantasy/reminders.ts`, worker cron — e.g.
   Sunday + early Monday before the 14:30 lock, holiday-aware): for each `active`
   league, find managers whose next-week lineup is incomplete, write a
   `lineup_reminder` notification + WS push, deduped by Redis flag per (league,
   week, user).
3. **Draft reminder** — on draft `scheduled`/imminent (FS-03), notify all members
   ahead of `started_at`; deduped per draft.
4. **Recap generator** (`apps/api/src/fantasy/recap.ts`, after the FS-06 settle):
   per manager compose `{ matchupResult, myScore, oppScore, biggestMover,
   biggestBlowup, leagueHighLow }` from `fs_weekly_score.breakdown` +
   `fs_matchup`; write a `recap` notification and a league-wide summary. Publish
   `recap.ready`.
5. **Feed endpoints.** `GET /leagues/:id/notifications` (mine, paginated),
   `POST /leagues/:id/notifications/:nid/read`. FS-09 renders these and a recap
   view.
6. **Tests.** Reminder fires once per window (Redis dedupe), and only for
   incomplete lineups; recap pulls the correct biggest mover/blowup from a known
   breakdown; recap is idempotent on a re-score.

## Files
- Create: `apps/api/migrations/1700000000015_fs_notifications.sql`,
  `apps/api/src/fantasy/reminders.ts`, `fantasy/recap.ts`,
  `apps/api/src/routes/leagues/notifications.ts`,
  `apps/api/test/fantasy/reminders.test.ts`, `test/fantasy/recap.test.ts`.
- Edit: `apps/api/src/jobs/scheduler.ts` (reminder + recap firings),
  `events/publisher.ts`, `apps/api/src/routes/leagues/index.ts`,
  `packages/shared-types/src/fantasy.ts`,
  `apps/web/src/features/fantasy/` (notification feed + recap view).

## Definition of done
- [ ] A manager with an incomplete lineup gets one `lineup_reminder` before the
      Monday lock (not repeated every tick); a complete lineup gets none.
- [ ] Members are reminded before a scheduled draft starts.
- [ ] After the Friday settle, each manager has a `recap` with their result,
      biggest mover, and blowup drawn from the FS-05 breakdown; a re-score
      regenerates it cleanly.
- [ ] Notifications are visible in the FS-09 feed and pushed live over WS.
- [ ] No manager-facing reminder is routed through the ops Discord webhook;
      email is documented as deferred.
