-- Fantasy Street item 08: season lifecycle & playoffs.
--
-- Turns the implicit `season=1` carried by FS-04/05/06 (the `season SMALLINT`
-- columns on fs_lineup / fs_weekly_score / fs_matchup) into a first-class
-- lifecycle row a league runs season over season:
--   forming → drafting → active (regular) → playoffs → archived (fs_league),
--   regular → playoffs → archived                       (fs_season).
-- A short regular season seeds a single-elimination bracket from fs_standings,
-- the bracket crowns a champion, the season is archived, and a new season can
-- re-draft while membership + history persist. See
-- TODO/fantasy-street/08-season-and-playoffs.md.
--
--   fs_season — one row per (league, season_number); the lifecycle the existing
--               `season SMALLINT` columns now FK to (human-readable numbering is
--               kept on those columns). champion_user_id is NULL until crowned.
--
-- Additive: every pre-FS-08 row is backfilled to its league's season-1 row
-- (the docs/02-data-model.md §5 nullable→backfill→NOT NULL convention), so no
-- existing data is lost and the FK can be made NOT NULL.

CREATE TABLE fs_season (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id        UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  -- Human-readable numbering, mirrored by the `season SMALLINT` columns.
  season_number    SMALLINT    NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'regular'
                     CHECK (status IN ('regular', 'playoffs', 'archived')),
  -- Regular-season length; the bracket opens the week after.
  regular_weeks    SMALLINT    NOT NULL CHECK (regular_weeks > 0),
  -- Top-K standings seeds into the single-elim bracket (4 or 6 with byes).
  playoff_seeds    SMALLINT    NOT NULL DEFAULT 4 CHECK (playoff_seeds >= 2),
  -- NULL until the final playoff matchup settles.
  champion_user_id UUID        REFERENCES app_user(id),
  started_at       TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  -- One season row per league per number; ensureSeason upserts off this.
  UNIQUE (league_id, season_number)
);

CREATE INDEX fs_season_league_idx ON fs_season (league_id);

-- Playoff games reuse fs_matchup: is_playoff flags them out of standings
-- aggregation (settle.ts rebuilds standings from is_playoff=false only), round
-- numbers the single-elim tier (1 = first round … final = the last).
ALTER TABLE fs_matchup
  ADD COLUMN is_playoff BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN round      SMALLINT;

-- Backfill a season-1 row per existing league. Status mirrors the league's
-- current lifecycle so an in-flight league reconciles (active/forming/drafting
-- → regular). playoff_seeds is clamped to the league size so a tiny league's
-- bracket can be seeded; regular_weeks carries the configured season length.
INSERT INTO fs_season
  (league_id, season_number, status, regular_weeks, playoff_seeds, started_at)
SELECT
  id,
  1,
  CASE status
    WHEN 'playoffs' THEN 'playoffs'
    WHEN 'archived' THEN 'archived'
    ELSE 'regular'
  END,
  season_length_weeks,
  LEAST(4, size),
  created_at
FROM fs_league;

-- season_id FK on the three season-scoped tables: add nullable, backfill to the
-- league's season-1 row, then constrain + NOT NULL (§5 pattern).
ALTER TABLE fs_lineup       ADD COLUMN season_id UUID;
ALTER TABLE fs_weekly_score ADD COLUMN season_id UUID;
ALTER TABLE fs_matchup      ADD COLUMN season_id UUID;

UPDATE fs_lineup l
   SET season_id = s.id
  FROM fs_season s
 WHERE s.league_id = l.league_id AND s.season_number = l.season;

UPDATE fs_weekly_score w
   SET season_id = s.id
  FROM fs_season s
 WHERE s.league_id = w.league_id AND s.season_number = w.season;

UPDATE fs_matchup m
   SET season_id = s.id
  FROM fs_season s
 WHERE s.league_id = m.league_id AND s.season_number = m.season;

ALTER TABLE fs_lineup
  ADD CONSTRAINT fs_lineup_season_fk
    FOREIGN KEY (season_id) REFERENCES fs_season(id),
  ALTER COLUMN season_id SET NOT NULL;

ALTER TABLE fs_weekly_score
  ADD CONSTRAINT fs_weekly_score_season_fk
    FOREIGN KEY (season_id) REFERENCES fs_season(id),
  ALTER COLUMN season_id SET NOT NULL;

ALTER TABLE fs_matchup
  ADD CONSTRAINT fs_matchup_season_fk
    FOREIGN KEY (season_id) REFERENCES fs_season(id),
  ALTER COLUMN season_id SET NOT NULL;
