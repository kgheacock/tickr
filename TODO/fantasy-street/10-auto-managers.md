# FS-10 · Auto-managers (bots)

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 03, 04

## User stories
- As a commissioner, I want to fill empty spots with auto-managers, so that we
  can play even without a full group.

## Goal

Let a commissioner fill empty league spots with **auto-managers** that draft and
field a legal lineup every week unattended, so a group smaller than the league
size can still play a full schedule. Auto-managers are ordinary league members
flagged as bots; they reuse the FS-03 auto-draft and FS-04 auto-fill paths.

## Pre-reads
- [FS-03](03-live-draft.md) — `autodraft.ts` (best-available-by-need) is the
  bot's draft brain; the api-process pick-clock already auto-picks on expiry.
- [FS-04](04-rosters-and-lineups.md) — `autofill.ts` and the Monday lock job
  already produce a legal lineup for any manager who didn't set one.
- [04-auth.md step 9](../04-auth.md) — the **system-user seed pattern**; bot
  users are modeled on this, not on deleted infra (see decision below).

## Design decisions
- **The story note is stale — do not inherit it.** "Reuse the existing bot
  infrastructure" refers to infra **deleted by platformization**
  ([16 §A](../16-platformize-api.md)): `src/bot/`, `roles/bot.ts`, the `bot`
  ROLE, and the `algo` table are gone. FS auto-managers are **net-new**, modeled
  on the surviving **system-user seed** (04-auth step 9) + the FS-03/04 auto
  paths. There is no separate bot worker/role.
- **Bots are members, not a special case.** A bot is an `app_user` with no
  `identity` rows, flagged via a new column/table, added as an
  `fs_league_member`. Every league code path (draft order, ownership, scoring,
  matchups, standings) treats it like any manager — the only difference is bots
  never act interactively, so the existing **auto** branches always fire for
  them.

## Steps
1. **Schema** — `1700000000014_fs_bots.sql`:
   - Add `is_bot BOOLEAN NOT NULL DEFAULT false` to `app_user` (or an
     `fs_bot_member (league_id, user_id, strategy)` table if we prefer to keep
     `app_user` untouched — **recommended:** the dedicated table, since
     bot-ness is FS-scoped).
   - `fs_bot_member` — `league_id`, `user_id → app_user(id)`,
     `strategy TEXT DEFAULT 'best_available'`, `created_at`,
     `PRIMARY KEY (league_id, user_id)`.
2. **Bot user provisioning** (`apps/api/src/fantasy/bots.ts`) — mint a reserved
   `app_user` (no identities, generated `display_name` like "CPU — Bull"),
   idempotently, modeled on `bootstrap/system-user.ts`.
3. **`POST /leagues/:id/bots`** (commissioner, while `forming`) — add N
   auto-managers up to the open-slot count; each creates a bot `app_user` +
   `fs_league_member` + `fs_bot_member`. `DELETE /leagues/:id/bots/:userId`
   removes one before the draft.
4. **Draft behavior.** When a bot is on the clock, the FS-03 clock invokes
   `autodraft.ts` immediately (no waiting on the timer) — gate the auto-pick path
   on `fs_bot_member` membership so bots pick instantly and humans still get
   their timer.
5. **Weekly behavior.** Bots rely on the FS-04 Monday lock auto-fill to field a
   legal lineup; no extra job. Optionally vary by `strategy` later (e.g. a
   short-happy bot favors Defense) — keep `best_available` for v1.
6. **Tests.** A league short of humans fills with bots and drafts to completion
   unattended; bots field complete legal lineups each week; bots are scored and
   ranked identically to humans; removing a bot pre-draft frees the slot.

## Files
- Create: `apps/api/migrations/1700000000014_fs_bots.sql`,
  `apps/api/src/fantasy/bots.ts`, `apps/api/src/routes/leagues/bots.ts`,
  `apps/api/test/fantasy/bots.test.ts`.
- Edit: `apps/api/src/fantasy/draft.ts` (instant auto-pick for bots),
  `apps/api/src/routes/leagues/index.ts`,
  `packages/shared-types/src/fantasy.ts`.

## Definition of done
- [ ] A commissioner fills empty spots with auto-managers up to league size; a
      4-human league of 8 can play.
- [ ] In the draft, bots pick instantly via FS-03 auto-draft (need-aware, legal,
      invariant-respecting) without holding up the clock.
- [ ] Each week bots field a complete, legal lineup via the FS-04 lock auto-fill;
      no empty mandatory slots.
- [ ] Bots are drafted, scored, matched, and ranked exactly like human managers.
- [ ] No `bot` role or `algo` table is reintroduced; bots are seeded on the
      system-user pattern.
