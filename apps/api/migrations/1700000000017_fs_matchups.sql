-- Fantasy Street item 06: matchups, schedule & standings.
--
-- Turns weekly scores into head-to-head competition: a round-robin schedule is
-- generated once the draft completes, each week settles one matchup per manager
-- on total points, and standings rank managers by a documented tiebreaker order.
-- This is the win/loss spine FS-08 (playoffs) builds its bracket on. See
-- TODO/fantasy-street/06-matchups-and-standings.md and the epic README →
-- "Scoring rules" for the points that feed each matchup.
--
--   fs_matchup    — one head-to-head per (league, season, week, home manager).
--                   away_user_id NULL is a bye (odd league size); the bye is a
--                   no-contest by default (locked decision), so it scores no
--                   win/loss and is excluded from standings aggregation.
--   fs_standings  — a derived read cache, one row per (league, season, manager),
--                   rebuilt from fs_matchup after each settlement. Standings are
--                   always reproducible from fs_matchup; this exists for reads.
--
-- season defaults to 1 so FS-08's season lifecycle is additive (mirrors the
-- fs_lineup / fs_weekly_score convention). week is league-relative (1..
-- season_length_weeks); the schedule generator owns the week numbering.

CREATE TABLE fs_matchup (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id      UUID          NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  season         SMALLINT      NOT NULL DEFAULT 1,
  week           SMALLINT      NOT NULL,
  home_user_id   UUID          NOT NULL REFERENCES app_user(id),
  -- NULL = bye: the home manager sits this week with no opponent.
  away_user_id   UUID          REFERENCES app_user(id),
  -- NULL until the week settles; the settled total points for each side.
  home_points    NUMERIC(12,2),
  away_points    NUMERIC(12,2),
  -- NULL = tie, unsettled, or a bye (no-contest). Set to the higher-scoring side.
  winner_user_id UUID          REFERENCES app_user(id),
  status         TEXT          NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled', 'final')),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- One matchup per manager per scoring week; the generator is idempotent off it.
  UNIQUE (league_id, season, week, home_user_id)
);

-- The week-read path (settle, schedule view) is per (league, season, week).
CREATE INDEX fs_matchup_league_week_idx
  ON fs_matchup (league_id, season, week);

CREATE TABLE fs_standings (
  league_id      UUID          NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  season         SMALLINT      NOT NULL DEFAULT 1,
  user_id        UUID          NOT NULL REFERENCES app_user(id),
  wins           SMALLINT      NOT NULL DEFAULT 0,
  losses         SMALLINT      NOT NULL DEFAULT 0,
  ties           SMALLINT      NOT NULL DEFAULT 0,
  points_for     NUMERIC(12,2) NOT NULL DEFAULT 0,
  points_against NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- 1-based finishing position after the tiebreaker sort; unique within a league.
  rank           SMALLINT      NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, season, user_id)
);
