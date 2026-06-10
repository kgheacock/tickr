# FS-08 · Season & playoffs

**Status:** `pending` · **Epic:** [Fantasy Street](README.md) · **Depends on:** 06

## User stories
- As a manager, I want a short regular season followed by playoffs, so that the
  season stays exciting and the best teams are tested.
- As a manager, I want a champion crowned and past seasons remembered, so that
  bragging rights carry over year to year.

## Goal

Formalize the **season lifecycle**: a short regular season → a **playoff
bracket** seeded by standings → a crowned **champion** → an **archived** season,
so a league can run season over season. This is the additive item that turns the
implicit `season=1` (carried by FS-04/05/06) into a first-class lifecycle.

## Pre-reads
- [Epic README → Locked decisions](README.md#locked-decisions) — season length /
  cadence.
- [FS-06](06-matchups-and-standings.md) — `fs_standings` seeds the bracket;
  `fs_matchup` is reused for playoff games (`is_playoff` flag).
- [FS-01](01-leagues-and-membership.md) — `fs_league.status` lifecycle
  (`active → playoffs → archived`).
- [docs/02-data-model.md §5](../../docs/02-data-model.md#5-v2-schema-outlook) —
  the v2 `season` concept this realizes for the FS layer.

## Design decisions
- **`fs_season` is introduced here, additively.** FS-04/05/06 already carry
  `season SMALLINT DEFAULT 1`; this item adds the `fs_season` lifecycle row those
  columns FK to (backfill existing rows to season 1, like the
  [§5 nullable→backfill→NOT NULL pattern](../../docs/02-data-model.md#5-v2-schema-outlook)).
- **Bracket** — top-K seeds (default 4 or 6 with byes), single-elimination, one
  matchup per playoff week, reusing `fs_matchup` with `is_playoff=true`. Higher
  seed is `home`.
- **Lifecycle** — `forming → drafting → active (regular) → playoffs → archived`.
  A new season for the same league resets rosters (re-draft) but preserves
  membership and history.

## Steps
1. **Schema** — `1700000000013_fs_season.sql`:
   - `fs_season` — `id`, `league_id`, `season_number SMALLINT`,
     `status TEXT CHECK (status IN ('regular','playoffs','archived'))`,
     `regular_weeks SMALLINT`, `playoff_seeds SMALLINT`,
     `champion_user_id` (NULL until crowned), `started_at`, `ended_at`,
     `UNIQUE (league_id, season_number)`.
   - Add `is_playoff BOOLEAN DEFAULT false` + `round SMALLINT` to `fs_matchup`.
   - Backfill a season-1 `fs_season` row per existing league, then tie the
     `season` columns on `fs_lineup`/`fs_weekly_score`/`fs_matchup` to it:
     `ALTER TABLE … ADD COLUMN season_id UUID` (nullable) → backfill to that
     league's season-1 row → `ADD CONSTRAINT … FK fs_season(id)` →
     `ALTER COLUMN season_id SET NOT NULL` (the §5 nullable→backfill→NOT NULL
     pattern). Keep the existing `season SMALLINT` for human-readable numbering.
2. **Season start.** On `draft.complete` (FS-03), create/activate the `fs_season`
   row (`status='regular'`, `season_number`, `regular_weeks` from league config).
3. **Regular-season end → playoffs.** When the last regular week settles
   (FS-06), flip `fs_season.status='playoffs'` and `fs_league.status='playoffs'`,
   seed the bracket from `fs_standings` (top `playoff_seeds`), and generate
   round-1 playoff `fs_matchup` rows (`is_playoff=true`).
4. **Bracket advance** (`apps/api/src/fantasy/playoffs.ts`) — on each playoff
   week's settle, advance winners to the next round; when one matchup remains and
   settles, set `champion_user_id`, `status='archived'`, `fs_league.status` back
   toward idle, publish `season.champion`.
5. **History.** `GET /leagues/:id/seasons` (past seasons + champions) and
   `GET /leagues/:id/seasons/:n` (final standings + bracket). Archived seasons are
   read-only.
6. **New season.** `POST /leagues/:id/seasons` (commissioner) opens the next
   `fs_season`, resets `fs_roster_entry`/lineups, returns the league to
   `forming`/`drafting` for a re-draft; membership + prior seasons persist.
7. **Tests.** Bracket seeding/order from standings; single-elim advance to a
   champion; archived season is immutable; a second season increments
   `season_number` and preserves history; season-1 backfill.

## Files
- Create: `apps/api/migrations/1700000000013_fs_season.sql`,
  `apps/api/src/fantasy/playoffs.ts`, `fantasy/season.ts`,
  `apps/api/src/routes/leagues/seasons.ts`,
  `apps/api/test/fantasy/playoffs.test.ts`, `test/fantasy/season.test.ts`.
- Edit: `apps/api/src/fantasy/settle.ts` (regular→playoff transition + advance),
  `apps/api/src/routes/leagues/index.ts`, `events/publisher.ts`,
  `packages/shared-types/src/fantasy.ts`.

## Definition of done
- [ ] A league plays its `regular_weeks`, then auto-enters playoffs with a
      standings-seeded bracket.
- [ ] The bracket advances by single elimination to a single champion, who is
      recorded on `fs_season` and announced via `season.champion`.
- [ ] Past seasons (with champions and final standings) are queryable and
      read-only.
- [ ] Starting a new season increments `season_number`, resets rosters for a
      re-draft, and preserves membership + history.
- [ ] Existing pre-FS-08 rows are backfilled to season 1 with no data loss.
