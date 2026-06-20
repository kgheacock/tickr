-- Fantasy Street refocus — drop head-to-head matchups & playoffs.
--
-- The game is now weekly-ranking-only: every manager's lineup is still scored
-- each week (fs_weekly_score), and managers are ranked within the league by that
-- weekly total. There are no head-to-head matchups, no win/loss/tie standings,
-- and no playoff bracket or champion. A season remains only as a container so a
-- league can re-draft; it archives when its configured weeks elapse, no winner.
--
-- This removes the FS-06 matchup/standings spine and the FS-08 playoff layer:
--   - fs_matchup   — the per-week head-to-head pairings (incl. playoff games).
--   - fs_standings — the derived W/L/T standings cache.
--   - fs_season    — keeps the season container, drops the playoff fields and
--                    the 'playoffs' lifecycle state.
--   - fs_league    — drops the 'playoffs' lifecycle state.
-- Weekly ranking is derived on read from fs_weekly_score; no new storage.

DROP TABLE IF EXISTS fs_matchup;
DROP TABLE IF EXISTS fs_standings;

-- Reconcile any in-flight playoff rows back to a live state before tightening
-- the CHECKs (no playoff lifecycle exists anymore).
UPDATE fs_season SET status = 'archived' WHERE status = 'playoffs';
UPDATE fs_league SET status = 'active'   WHERE status = 'playoffs';

ALTER TABLE fs_season
  DROP COLUMN playoff_seeds,
  DROP COLUMN champion_user_id;

ALTER TABLE fs_season
  DROP CONSTRAINT fs_season_status_check;
ALTER TABLE fs_season
  ADD CONSTRAINT fs_season_status_check
  CHECK (status IN ('regular', 'archived'));

ALTER TABLE fs_league
  DROP CONSTRAINT fs_league_status_check;
ALTER TABLE fs_league
  ADD CONSTRAINT fs_league_status_check
  CHECK (status IN ('forming', 'drafting', 'active', 'archived'));
