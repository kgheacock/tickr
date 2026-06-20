-- Fantasy Street item 04: weekly starting lineups + the Monday-open lock.
--
-- A lineup is a manager's per-week choice of which owned stocks start in which
-- slot. It is set freely until the market opens for that scoring week, then
-- frozen: locked_at stamps the freeze, and any incomplete lineup is auto-filled
-- at lock time (auto_filled records that). The frozen (symbol, slot, is_short)
-- set is what FS-05 scores. See TODO/fantasy-street/04-rosters-and-lineups.md.
--
--   fs_lineup       — one row per (league, manager, season, week): the header +
--                     lock state.
--   fs_lineup_slot  — the started set; one row per filled slot position.

-- Week is league-relative (1..season_length_weeks); the schedule→week mapping is
-- FS-06's job. season defaults to 1 so FS-08's season lifecycle is additive.
CREATE TABLE fs_lineup (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id   UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES app_user(id),
  season      SMALLINT    NOT NULL DEFAULT 1,
  week        SMALLINT    NOT NULL,
  -- NULL until the scoring week's market open freezes the lineup.
  locked_at   TIMESTAMPTZ,
  -- True when the lock job had to auto-fill one or more mandatory slots.
  auto_filled BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One lineup per manager per scoring week.
  UNIQUE (league_id, user_id, season, week)
);

CREATE INDEX fs_lineup_league_week_idx ON fs_lineup (league_id, season, week);

-- The started set. slot_index disambiguates repeated slots (e.g. two bench
-- spots, or a roster with two Growth slots). is_short is derived from the slot
-- at set/lock time: Defense is a short, every long slot a long (placing an owned
-- stock in Defense converts it to a short for the week).
CREATE TABLE fs_lineup_slot (
  lineup_id  UUID     NOT NULL REFERENCES fs_lineup(id) ON DELETE CASCADE,
  slot       TEXT     NOT NULL CHECK (slot IN
               ('anchor', 'growth', 'momentum', 'value', 'defense', 'wildcard', 'bench')),
  slot_index SMALLINT NOT NULL DEFAULT 0,
  symbol     TEXT     NOT NULL REFERENCES universe_symbol(symbol),
  is_short   BOOLEAN  NOT NULL DEFAULT false,
  PRIMARY KEY (lineup_id, slot, slot_index),
  -- A symbol is started at most once per lineup (no double-starting).
  UNIQUE (lineup_id, symbol)
);
