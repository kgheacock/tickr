/**
 * Fantasy Street item 11 — manager reminders.
 *
 * Two producers over the notification feed (notifications.ts):
 *   - lineup reminders: a worker tick (Sun + early Mon, before the 14:30 lock)
 *     nudges managers whose lineup for the scoring week is still incomplete.
 *   - draft reminders: fired event-driven from the draft route the moment a
 *     commissioner *schedules* the draft (status → scheduled) — fs_draft has no
 *     future "scheduled_for" column, only started_at stamped at the flip to
 *     in_progress, so "before the draft starts" means at scheduling, not a timer.
 *
 * Reuse the alert *pattern* (fire once per window), not the alert *path*: these
 * go to the persisted in-app feed, never the ops Discord webhook. Dedupe is the
 * fs_notification UNIQUE constraint, so insertReminder is safe on every tick.
 * Bots (FS-10) are skipped — they have no human and auto-fill anyway.
 */
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { loadRosterConfig } from './lineup.js';
import { mandatorySlots } from './autofill.js';
import { insertReminder } from './notifications.js';
import { publishNotification } from '../events/publisher.js';

interface MemberLineupRow {
  user_id: string;
  locked_at: Date | null;
  started: number;
}

/**
 * Human members of a league whose (season, week) lineup is *incomplete* — no
 * lineup row, or fewer started (non-bench) slots than the roster's mandatory
 * count. Already-locked lineups are excluded (too late to act; auto-fill ran).
 * Bots are excluded via fs_bot_member.
 */
async function incompleteManagers(
  pool: Pool,
  leagueId: string,
  season: number,
  week: number,
): Promise<string[]> {
  const cfg = await loadRosterConfig(pool, leagueId);
  const required = mandatorySlots(cfg).length;

  const { rows } = await pool.query<MemberLineupRow>(
    `SELECT m.user_id,
            l.locked_at,
            COALESCE(cnt.n, 0)::int AS started
       FROM fs_league_member m
       LEFT JOIN fs_lineup l
         ON l.league_id = m.league_id AND l.user_id = m.user_id
        AND l.season = $2 AND l.week = $3
       LEFT JOIN (
         SELECT lineup_id, count(*)::int AS n
           FROM fs_lineup_slot
          WHERE slot <> 'bench'
          GROUP BY lineup_id
       ) cnt ON cnt.lineup_id = l.id
      WHERE m.league_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM fs_bot_member b
           WHERE b.league_id = m.league_id AND b.user_id = m.user_id
        )
      ORDER BY m.user_id`,
    [leagueId, season, week],
  );

  return rows
    .filter((r) => r.locked_at == null && r.started < required)
    .map((r) => r.user_id);
}

export interface ReminderResult {
  /** lineup_reminder notifications newly written this run. */
  reminders: number;
}

/**
 * Fire a one-time lineup reminder to every manager whose scoring-week lineup is
 * incomplete, across every active league. Idempotent per (user, week):
 * a re-fire on the next tick writes nothing (DB dedupe). `redis`, when present,
 * pushes each new reminder to the manager's live feed. The target week is the
 * one the lock job locks (currentWeek), supplied by the caller.
 */
export async function runLineupReminders(
  pool: Pool,
  opts: { week: number; season?: number },
  redis?: Redis,
): Promise<ReminderResult> {
  const season = opts.season ?? 1;
  const week = opts.week;

  const { rows: leagues } = await pool.query<{ id: string }>(
    `SELECT id FROM fs_league WHERE status = 'active' ORDER BY id`,
  );

  const result: ReminderResult = { reminders: 0 };
  for (const { id: leagueId } of leagues) {
    const managers = await incompleteManagers(pool, leagueId, season, week);
    for (const userId of managers) {
      const notification = await insertReminder(pool, {
        leagueId,
        userId,
        kind: 'lineup_reminder',
        dedupeKey: `lineup:${season}:${week}`,
        payload: { leagueId, season, week },
      });
      if (!notification) continue; // already reminded this window
      result.reminders += 1;
      if (redis) await publishNotification(redis, userId, notification);
    }
  }
  return result;
}

/**
 * Fire a one-time draft reminder to every human member when a draft is
 * scheduled. Called from the draft route after scheduleDraft commits. Deduped
 * per draft, so re-scheduling (or a retried request) never double-notifies.
 */
export async function notifyDraftScheduled(
  pool: Pool,
  leagueId: string,
  draftId: string,
  redis?: Redis,
): Promise<number> {
  const { rows: members } = await pool.query<{ user_id: string }>(
    `SELECT m.user_id
       FROM fs_league_member m
      WHERE m.league_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM fs_bot_member b
           WHERE b.league_id = m.league_id AND b.user_id = m.user_id
        )
      ORDER BY m.user_id`,
    [leagueId],
  );

  let fired = 0;
  for (const { user_id: userId } of members) {
    const notification = await insertReminder(pool, {
      leagueId,
      userId,
      kind: 'draft_reminder',
      dedupeKey: `draft:${draftId}`,
      payload: { leagueId, draftId },
    });
    if (!notification) continue;
    fired += 1;
    if (redis) await publishNotification(redis, userId, notification);
  }
  return fired;
}
