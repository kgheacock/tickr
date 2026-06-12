-- Fantasy Street item 03: the live snake draft.
--
-- Two tables here; the third (fs_roster_entry, the ownership table) was created
-- in 1700000000013_fs_classification because FS-02 must read it — FS-03 only
-- *writes* to it. See
-- TODO/fantasy-street/03-live-draft.md.
--
--   fs_draft       — one row per league: the draft's lifecycle + pick clock.
--   fs_draft_pick  — the immutable pick log; the snake order materialized one
--                    row at a time as picks land.

-- One draft per league. The pick clock is a Redis-backed deadline advanced by
-- an in-process timer (fantasy/draftClock.ts); only the durable lifecycle lives
-- here. current_overall_pick is 1-based and walks 1..(size * total_rounds); when
-- it passes the last pick the draft is complete.
CREATE TABLE fs_draft (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id           UUID        NOT NULL UNIQUE REFERENCES fs_league(id) ON DELETE CASCADE,
  status              TEXT        NOT NULL DEFAULT 'scheduled'
                        CHECK (status IN ('scheduled', 'in_progress', 'complete')),
  pick_seconds        SMALLINT    NOT NULL DEFAULT 60 CHECK (pick_seconds > 0),
  current_overall_pick INT        NOT NULL DEFAULT 1 CHECK (current_overall_pick >= 1),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The pick log. PRIMARY KEY (draft_id, overall_pick) is the position guard: it
-- makes a manual pick and an expiry auto-pick for the same slot a race that
-- exactly one writer wins (the loser sees 23505 and re-reads whose turn it is).
-- Distinct from fs_roster_entry's UNIQUE (league_id, symbol), the ownership
-- guard — both raise 23505, disambiguated by constraint name.
CREATE TABLE fs_draft_pick (
  draft_id     UUID        NOT NULL REFERENCES fs_draft(id) ON DELETE CASCADE,
  overall_pick INT         NOT NULL,
  round        SMALLINT    NOT NULL,
  user_id      UUID        NOT NULL REFERENCES app_user(id),
  symbol       TEXT        NOT NULL REFERENCES universe_symbol(symbol),
  is_short     BOOLEAN     NOT NULL DEFAULT false,
  auto         BOOLEAN     NOT NULL DEFAULT false,
  picked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (draft_id, overall_pick)
);

CREATE INDEX fs_draft_pick_user_idx ON fs_draft_pick (draft_id, user_id);
