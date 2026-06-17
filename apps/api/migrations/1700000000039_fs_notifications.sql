-- Fantasy Street item 11: reminders & recaps.
--
-- A persisted, in-app notification feed — the platform has no user-facing
-- channel yet (only live WS and an ops Discord webhook), so reminders and
-- recaps are delivered as durable rows surfaced on the FS-09 dashboard and
-- pushed live over WS. Email/push is deferred (no provider is wired).
--
--   fs_notification — one row per (manager, kind, window):
--     - lineup_reminder : "set your team before Monday's lock" (per season/week)
--     - draft_reminder  : "your draft is scheduled" (per draft)
--     - recap           : the post-settle weekly recap (per season/week)
--
-- DEDUPE IS A DB INVARIANT, NOT A REDIS FLAG. Unlike the ops alert checker
-- (alerts/checker.ts), these are persisted, user-visible rows — a duplicate is
-- a visible bug, and a Redis flush would re-fire it. So a stable `dedupe_key`
-- per (user, kind) carries "once per window": reminders INSERT … ON CONFLICT DO
-- NOTHING (fire exactly once), recaps ON CONFLICT DO UPDATE (a re-score
-- regenerates the payload in place and clears read_at so the correction
-- re-surfaces). dedupe_key examples: 'lineup:1:1', 'recap:1:1', 'draft:<uuid>'.
CREATE TABLE fs_notification (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id  UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind       TEXT        NOT NULL
               CHECK (kind IN ('lineup_reminder', 'draft_reminder', 'recap')),
  -- Stable per (user, kind) idempotency key — the dedupe authority (see above).
  dedupe_key TEXT        NOT NULL,
  payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ,
  -- One notification per (manager, kind, window): the upsert target.
  UNIQUE (user_id, kind, dedupe_key)
);

-- The feed read path is "my notifications, newest first".
CREATE INDEX fs_notification_user_idx
  ON fs_notification (user_id, created_at DESC);
