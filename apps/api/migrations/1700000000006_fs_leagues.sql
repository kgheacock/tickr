-- Fantasy Street, item 01 (TODO/fantasy-street/01-leagues-and-membership.md):
-- the league container and membership lifecycle every later FS item hangs off.
--
-- Conventions established here and reused epic-wide:
--   * fs_* table prefix; one migration per FS item, continuing from …005.
--   * app_user is the only identity table FS reuses (portfolio/game tables were
--     dropped in migration 003 when the API was platformized).
--
-- A league is owned by a commissioner, holds 4–12 managers, carries its config
-- (size, season length, roster slots, join policy) and moves through a status
-- lifecycle: forming → drafting → active → playoffs → archived.

CREATE TABLE fs_league (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT        NOT NULL,
  commissioner_user_id UUID        NOT NULL REFERENCES app_user(id),
  -- 4–12 managers; locked decision (epic README).
  size                 SMALLINT    NOT NULL CHECK (size BETWEEN 4 AND 12),
  season_length_weeks  SMALLINT    NOT NULL CHECK (season_length_weeks > 0),
  -- Slot layout (Anchor/Growth/Momentum/Value/Defense/Wildcard + bench).
  -- Shape validated in the app layer (apps/api/src/fantasy/leagues.ts).
  roster_config        JSONB       NOT NULL,
  join_policy          TEXT        NOT NULL CHECK (join_policy IN ('invite', 'open')),
  status               TEXT        NOT NULL DEFAULT 'forming'
                         CHECK (status IN ('forming', 'drafting', 'active', 'playoffs', 'archived')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Discovery query: open + forming leagues (GET /leagues?open=true).
CREATE INDEX fs_league_join_idx ON fs_league (join_policy, status);

CREATE TABLE fs_league_member (
  league_id UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES app_user(id),
  role      TEXT        NOT NULL CHECK (role IN ('commissioner', 'manager')),
  team_name TEXT,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One membership per user per league (DB-enforced — DoD).
  PRIMARY KEY (league_id, user_id)
);

-- "My leagues" lookup for the /me extension.
CREATE INDEX fs_league_member_user_idx ON fs_league_member (user_id);

CREATE TABLE fs_invite (
  token      TEXT        PRIMARY KEY,
  league_id  UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  created_by UUID        NOT NULL REFERENCES app_user(id),
  expires_at TIMESTAMPTZ,
  -- NULL max_uses = unlimited until expiry.
  max_uses   SMALLINT    CHECK (max_uses IS NULL OR max_uses > 0),
  uses       SMALLINT    NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fs_invite_league_idx ON fs_invite (league_id);
