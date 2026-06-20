-- Fantasy Street, item 10 (TODO/fantasy-street/10-auto-managers.md):
-- auto-managers ("bots") that let a group smaller than the league size still
-- play a full schedule. A bot is an ordinary league member — a reserved
-- app_user with no identity rows — flagged here so the draft can pick for it
-- instantly and the rest of the epic (ownership, scoring, matchups, standings)
-- treats it like any manager.
--
-- bot-ness is FS-scoped, so it lives in a dedicated table rather than a column
-- on the shared app_user. ON DELETE CASCADE on both FKs lets a commissioner drop
-- a bot pre-draft by deleting its app_user (which also clears its membership via
-- the fs_league_member cascade) without leaving a dangling flag.

CREATE TABLE fs_bot_member (
  league_id  UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- Draft/lineup behaviour selector; only 'best_available' is wired for v1.
  strategy   TEXT        NOT NULL DEFAULT 'best_available',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, user_id)
);

-- "Is this user a bot in this league?" is the draft-clock hot path; the PK
-- already covers (league_id, user_id) lookups.
