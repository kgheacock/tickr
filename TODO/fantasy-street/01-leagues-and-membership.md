# FS-01 · Leagues & membership

**Status:** `done` ([#54](https://github.com/kgheacock/tickr/pull/54)) · **Epic:** [Fantasy Street](README.md) · **Depends on:** platform auth/sessions

## User stories
- As a manager, I want to create a league and invite 3–11 friends, so that we
  can compete in a small private group.
- As a manager, I want to join a league from an invite, so that I can take part
  without setup hassle.
- As a manager, I want to find and look up open leagues, so that I can join a
  game even without a direct invite.
- As a commissioner, I want to set league size, season length, and roster
  slots, so that the league fits our group.

## Goal

Stand up the league container and membership lifecycle that every later item
hangs off. A league is owned by a **commissioner**, holds 4–12 **managers**,
carries the **configuration** (size, season length, roster slots, join policy),
and moves through a status lifecycle. This is the first FS slice, so it also
**establishes the cross-cutting conventions** the rest of the epic reuses.

## Pre-reads

- [Epic README → Locked decisions](README.md#locked-decisions) — roster slots,
  cadence, league size bounds.
- `apps/api/src/auth/middleware.ts` — `requireAuth` (cookie → session →
  `req.user`); the FS guards wrap this.
- `apps/api/src/routes/me.ts` — the `MeResponse` shape FS extends with league
  membership.
- `apps/api/migrations/` — migration naming (`1700000000005…`); FS migrations
  continue from `…006`.
- [docs/02-data-model.md §2.1](../../docs/02-data-model.md#21-app_user) —
  `app_user`, the only identity table FS reuses (no `portfolio` — dropped in
  [16](../16-platformize-api.md)).

## Conventions established here (reused epic-wide)

- **Tables:** `fs_*` prefix; one migration per item under `apps/api/migrations/`.
- **Routes:** league-centric REST under `/api/v1/leagues`, handlers in
  `apps/api/src/routes/leagues/*.ts`.
- **Engine/domain logic:** `apps/api/src/fantasy/*`; **web:**
  `apps/web/src/features/fantasy/*`; **contracts:**
  `packages/shared-types/src/fantasy.ts`.
- **Authorization guards** (`apps/api/src/fantasy/guards.ts`):
  `requireLeagueMember(req, leagueId)` and `requireCommissioner(req, leagueId)`,
  both layered on `requireAuth`. All mutations require the existing
  `X-CSRF-Token`.

## Steps

1. **Schema** — `1700000000006_fs_leagues.sql`:
   - `fs_league` — `id UUID PK`, `name`, `commissioner_user_id → app_user(id)`,
     `size SMALLINT CHECK (size BETWEEN 4 AND 12)`, `season_length_weeks SMALLINT`,
     `roster_config JSONB NOT NULL` (slot layout — see step 2),
     `join_policy TEXT CHECK (join_policy IN ('invite','open'))`,
     `status TEXT CHECK (status IN ('forming','drafting','active','playoffs','archived'))
     DEFAULT 'forming'`, `created_at`.
   - `fs_league_member` — `league_id → fs_league(id) ON DELETE CASCADE`,
     `user_id → app_user(id)`, `role TEXT CHECK (role IN ('commissioner','manager'))`,
     `team_name`, `joined_at`, `PRIMARY KEY (league_id, user_id)`. The commissioner
     is also a member.
   - `fs_invite` — `token TEXT PK` (random 24-byte), `league_id`, `created_by`,
     `expires_at`, `max_uses SMALLINT`, `uses SMALLINT DEFAULT 0`.
2. **Roster config default.** Seed `roster_config` with the locked slot layout:
   `Anchor · Growth · Momentum · Value · Defense · Wildcard` + N bench (default 2).
   Validate on create that slots are non-empty and bench ≤ 4.
3. **`POST /api/v1/leagues`** — create. Body `{ name, size, seasonLengthWeeks,
   rosterConfig?, joinPolicy }`. Inserts `fs_league` + a `commissioner`
   `fs_league_member` in one txn. Returns `LeagueView`.
4. **`GET /api/v1/leagues/:id`** — `LeagueView` (config, status, members,
   open-slot count). Member or, for `open` leagues, any authenticated user.
5. **`GET /api/v1/leagues`** — discovery. `?mine=true` (my leagues) and
   `?open=true` (joinable `forming` + `open` leagues), paginated per the
   platform `Page<T>` convention.
6. **Invites.** `POST /api/v1/leagues/:id/invites` (commissioner) mints an
   `fs_invite`; `POST /api/v1/leagues/:id/join` accepts either `{ token }`
   (invite) or, for `open` leagues, no token. Rejects when full (`409 CONFLICT`),
   when not `forming` (`409`), or on a bad/expired token (`422`). Idempotent on
   re-join by an existing member.
7. **Settings.** `PATCH /api/v1/leagues/:id` (commissioner) edits name, size,
   `season_length_weeks`, `roster_config`, `join_policy` — **only while
   `forming`** (locked once `drafting` begins; FS-12 handles mid-season edits).
8. **`/me` extension.** Add `leagues: Array<{ leagueId, teamName, role, status }>`
   to `MeResponse` so the client can route to active leagues.
9. **Tests.** Create/join/leave happy paths; size-cap and status-gate rejections;
   invite expiry/use-count; the partial-member uniqueness (one membership per
   user per league).

## Files
- Create: `apps/api/migrations/1700000000006_fs_leagues.sql`,
  `apps/api/src/routes/leagues/index.ts` (register),
  `routes/leagues/create.ts`, `routes/leagues/view.ts`, `routes/leagues/list.ts`,
  `routes/leagues/invites.ts`, `routes/leagues/join.ts`, `routes/leagues/settings.ts`,
  `apps/api/src/fantasy/guards.ts`, `apps/api/test/fantasy/leagues.test.ts`.
- Edit: `apps/api/src/roles/api.ts` (register the `leagues` routes),
  `apps/api/src/routes/me.ts`, `packages/shared-types/src/fantasy.ts` +
  `index.ts`.

## Definition of done
- [x] A user creates a league, becomes its `commissioner` member, and it shows
      in `/me.leagues`.
- [x] A second user joins via a valid invite token and appears in `LeagueView`.
- [x] An `open` league is joinable without a token and is listed under
      `GET /leagues?open=true`; an `invite` league is not.
- [x] Joining a full league, an already-drafting league, or with an
      expired/over-used token is rejected with the correct code.
- [x] Commissioner can edit settings while `forming`; edits are rejected once
      the league leaves `forming`.
- [x] A user cannot hold two memberships in the same league (DB-enforced).
