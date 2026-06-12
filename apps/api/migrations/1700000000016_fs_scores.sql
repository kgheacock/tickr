-- Fantasy Street item 05: weekly scoring & shorting.
--
-- A weekly score is one manager's point total for a scoring week, derived from
-- their locked lineup's price moves: each started long slot scores r×10, each
-- Defense short scores −r×10, where r is the week's percent return. Losses count
-- fully and the total is uncapped (locked decisions; see the epic README →
-- "Scoring rules"). The full per-slot breakdown is persisted so the manager's
-- explainer, FS-06 matchups, and FS-11 recaps all read the same source.
--
--   fs_weekly_score — one row per (league, manager, season, week): the settled
--                     total plus the JSONB breakdown it sums from.
--
-- The breakdown is an array of objects, one per started (non-bench) slot:
--   { slot, symbol, isShort, lastClose, thisClose, returnPct, points }
-- lastClose/thisClose are the two point-in-time price_bar closes (cents, BIGINT
-- units), returnPct is the week's percent move, points is the scored value.
CREATE TABLE fs_weekly_score (
  league_id    UUID          NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  user_id      UUID          NOT NULL REFERENCES app_user(id),
  season       SMALLINT      NOT NULL DEFAULT 1,
  week         SMALLINT      NOT NULL,
  total_points NUMERIC(12,2) NOT NULL,
  breakdown    JSONB         NOT NULL DEFAULT '[]'::jsonb,
  computed_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  -- One settled score per manager per scoring week; re-scoring upserts in place.
  PRIMARY KEY (league_id, user_id, season, week)
);

-- The standings/matchup read path is per (league, week): every manager's total.
CREATE INDEX fs_weekly_score_league_week_idx
  ON fs_weekly_score (league_id, season, week);
