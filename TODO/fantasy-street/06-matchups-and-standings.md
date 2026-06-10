# FS-06 · Matchups, schedule & standings

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 03, 05

## User stories
- As a manager, I want to face one opponent each week and win or lose on total
  points, so that a great week can still lose to a luckier one.
- As a manager, I want a season schedule, so that I know who I play and when.
- As a manager, I want standings with clear tiebreakers, so that I can track my
  playoff position.

## Goal

Turn weekly scores into **head-to-head competition**: generate a **round-robin
schedule** when the draft completes, settle one **matchup** per manager per week
on total points, and maintain **standings** with explicit tiebreakers. This is
the win/loss spine FS-08 (playoffs) builds the bracket on.

## Pre-reads
- [FS-03](03-live-draft.md) — listens for `draft.complete` to generate the
  schedule.
- [FS-05](05-scoring-and-shorting.md) — `fs_weekly_score.total_points`, the input
  to each matchup result, and the `score.updated` event that triggers settlement.
- [Epic README → Locked decisions](README.md#locked-decisions) — weekly H2H,
  luck from the schedule.

## Design decisions
- **Schedule** — circle-method round-robin over the season length; an **odd
  league size gets a rotating bye** (the bye manager auto-wins/sits per league
  setting — default: counts as a no-contest, not a win). Generated once at
  `draft.complete`; regeneration only via FS-12 commissioner tools.
- **Result** — higher `total_points` wins; **tie** if equal (tracked as `tie`).
  Settlement is idempotent off `fs_weekly_score`, so a re-score (FS-12 dispute)
  re-settles the affected week and recomputes standings.
- **Standings tiebreakers** (in order): win% → total points-for → head-to-head →
  points-against (lower better). Documented and stable.
- Carries `season SMALLINT DEFAULT 1` so FS-08 season lifecycle is additive.

## Steps
1. **Schema** — `1700000000011_fs_matchups.sql`:
   - `fs_matchup` — `id UUID PK`, `league_id`, `season SMALLINT`, `week SMALLINT`,
     `home_user_id`, `away_user_id` (NULL = bye), `home_points NUMERIC(12,2)`,
     `away_points NUMERIC(12,2)`, `winner_user_id` (NULL = tie/unsettled),
     `status TEXT CHECK (status IN ('scheduled','final'))`,
     `UNIQUE (league_id, season, week, home_user_id)`.
   - Standings are **derived** from `fs_matchup`; materialize a
     `fs_standings` cache (`league_id, season, user_id, wins, losses, ties,
     points_for, points_against, rank`) for read load, rebuildable from matchups.
2. **Schedule generator** (`apps/api/src/fantasy/schedule.ts`) — on
   `draft.complete` (subscribe via `events/`), build the round-robin over
   `season_length_weeks`, insert `scheduled` `fs_matchup` rows (with byes for odd
   sizes). Idempotent per (league, season).
3. **Settlement** — on `score.updated` (FS-05): for the scored (league, week),
   fill `home_points`/`away_points` from `fs_weekly_score`, set `winner_user_id`
   (or tie), flip `status='final'`, then rebuild `fs_standings`.
4. **Read endpoints.** `GET /leagues/:id/schedule` (full season, my matchups
   highlighted), `GET /leagues/:id/matchups?week=` (the week's head-to-heads with
   live/provisional points from FS-05 step 6), `GET /leagues/:id/standings`
   (ranked, with the tiebreaker fields exposed).
5. **Standings rebuild** (`apps/api/src/fantasy/standings.ts`) — pure function
   over `fs_matchup` applying the tiebreaker order; called after each settlement
   and on demand.
6. **Tests.** Round-robin covers every pairing with no repeats before all are
   played; odd size yields one bye/week rotating; settlement picks the higher
   score and handles ties; tiebreaker ordering on constructed standings; re-score
   re-settles and re-ranks.

## Files
- Create: `apps/api/migrations/1700000000011_fs_matchups.sql`,
  `apps/api/src/fantasy/schedule.ts`, `fantasy/standings.ts`,
  `fantasy/settle.ts`, `apps/api/src/routes/leagues/matchups.ts`,
  `apps/api/test/fantasy/schedule.test.ts`, `test/fantasy/standings.test.ts`.
- Edit: `apps/api/src/events/` (subscribe to `draft.complete` / `score.updated`),
  `apps/api/src/routes/leagues/index.ts`, `packages/shared-types/src/fantasy.ts`.

## Definition of done
- [ ] When the draft completes, a full round-robin schedule is generated; an
      odd-sized league has exactly one bye per week, rotating.
- [ ] After the Friday score settles, each week's matchups go `final` with the
      higher total winning (ties recorded), and standings update.
- [ ] Standings rank by the documented tiebreaker order and expose the fields.
- [ ] A re-scored week (FS-12) re-settles its matchups and re-ranks standings.
- [ ] `GET /schedule`, `/matchups`, and `/standings` return correct data for an
      in-progress season.
