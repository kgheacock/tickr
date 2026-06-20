-- Fantasy Street item 12: commissioner & admin tools.
--
-- An append-only audit trail for every privileged league mutation. FS-01
-- through FS-11 mutate a league through ordinary member actions; FS-12 adds the
-- commissioner/admin overrides (mid-season settings, member management, dispute
-- re-scores, force-advance, lineup overrides). Those bypass the normal flow, so
-- each one writes a durable record here: who did what, to which league, when,
-- and (for disputes) why.
--
--   fs_audit_log — one row per privileged action:
--     - action  : a stable verb ('settings.update', 'member.remove',
--                  'member.transfer', 'score.rescore', 'season.advance',
--                  'lineup.override', …)
--     - detail  : action-specific context (the changed fields, target week,
--                  the commissioner's stated reason for a dispute re-score)
--
-- Append-only by design: rows are never updated or deleted in normal operation
-- (a league delete cascades). The trail is read newest-first per league for the
-- commissioner panel and the platform ops view.
CREATE TABLE fs_audit_log (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id     UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  -- The commissioner (or platform admin) who took the action.
  actor_user_id UUID        NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  action        TEXT        NOT NULL,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The read path is "this league's actions, newest first".
CREATE INDEX fs_audit_log_league_idx
  ON fs_audit_log (league_id, created_at DESC);
