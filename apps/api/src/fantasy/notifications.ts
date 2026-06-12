/**
 * Fantasy Street item 11 — the in-app notification feed.
 *
 * Pure, pool-driven domain (no Redis, no timers): write a notification, read a
 * manager's feed, and mark one read. The reminder/recap producers
 * (reminders.ts, recap.ts) and the draft route call the writers; the HTTP glue
 * is routes/leagues/notifications.ts and the live push is publishNotification
 * (events/publisher.ts). Everything testable lives here — see
 * test/fantasy/reminders.test.ts and recap.test.ts.
 *
 * Dedupe is a DB invariant (fs_notification UNIQUE (user_id, kind, dedupe_key)),
 * not a Redis flag: these are persisted, user-visible rows, so "once per window"
 * must survive a Redis flush. A reminder writes ON CONFLICT DO NOTHING (fire
 * exactly once); a recap upserts (a re-score regenerates the payload in place
 * and re-surfaces it by clearing read_at).
 */
import type { Pool, PoolClient } from 'pg';
import type { Notification, NotificationKind } from '@tickr/shared-types';
import { FantasyError } from './leagues.js';

export interface NewNotification {
  leagueId: string;
  userId: string;
  kind: NotificationKind;
  /** Stable per (user, kind) idempotency key — the dedupe authority. */
  dedupeKey: string;
  payload: unknown;
}

interface NotificationRow {
  id: string;
  league_id: string;
  kind: NotificationKind;
  payload: unknown;
  created_at: Date;
  read_at: Date | null;
}

function toNotification(r: NotificationRow): Notification {
  return {
    id: r.id,
    leagueId: r.league_id,
    kind: r.kind,
    // payload is JSONB; node-pg parses it into a plain object/array.
    payload: (r.payload ?? {}) as Notification['payload'],
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at ? r.read_at.toISOString() : null,
  };
}

const RETURNING = `id, league_id, kind, payload, created_at, read_at`;

/**
 * Write a reminder, firing exactly once per (user, kind, dedupe_key). Returns
 * the new row, or null when one already existed (so the caller skips the live
 * push). Idempotent — safe to call on every reminder tick.
 */
export async function insertReminder(
  db: Pool | PoolClient,
  n: NewNotification,
): Promise<Notification | null> {
  const { rows } = await db.query<NotificationRow>(
    `INSERT INTO fs_notification (league_id, user_id, kind, dedupe_key, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (user_id, kind, dedupe_key) DO NOTHING
     RETURNING ${RETURNING}`,
    [n.leagueId, n.userId, n.kind, n.dedupeKey, JSON.stringify(n.payload)],
  );
  return rows[0] ? toNotification(rows[0]) : null;
}

/**
 * Write or refresh a recap, keyed by (user, kind, dedupe_key). On a re-score the
 * payload is overwritten and read_at cleared so the corrected recap re-surfaces
 * as unread. Always returns the row (the caller pushes it live).
 */
export async function upsertRecap(
  db: Pool | PoolClient,
  n: NewNotification,
): Promise<Notification> {
  const { rows } = await db.query<NotificationRow>(
    `INSERT INTO fs_notification (league_id, user_id, kind, dedupe_key, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (user_id, kind, dedupe_key)
     DO UPDATE SET payload = EXCLUDED.payload,
                   created_at = now(),
                   read_at = NULL
     RETURNING ${RETURNING}`,
    [n.leagueId, n.userId, n.kind, n.dedupeKey, JSON.stringify(n.payload)],
  );
  return toNotification(rows[0]!);
}

export interface FeedOptions {
  /** Page back from this notification id (exclusive); omit for the newest page. */
  before?: string;
  /** Page size; clamped to [1, 100], default 50. */
  limit?: number;
}

/** A manager's notifications for a league, newest first (cursor-paginated). */
export async function listNotifications(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
  opts: FeedOptions = {},
): Promise<Notification[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  // Cursor on created_at of the `before` row; ties broken by id so the page
  // boundary is stable even when several notifications share a timestamp.
  const { rows } = await db.query<NotificationRow>(
    `SELECT ${RETURNING}
       FROM fs_notification n
      WHERE n.league_id = $1 AND n.user_id = $2
        AND ($3::uuid IS NULL OR
             (n.created_at, n.id) <
             (SELECT b.created_at, b.id FROM fs_notification b WHERE b.id = $3))
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $4`,
    [leagueId, userId, opts.before ?? null, limit],
  );
  return rows.map(toNotification);
}

/** Mark one of the caller's notifications read. Throws NOT_FOUND if it isn't theirs. */
export async function markRead(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
  notificationId: string,
): Promise<Notification> {
  const { rows } = await db.query<NotificationRow>(
    `UPDATE fs_notification
        SET read_at = COALESCE(read_at, now())
      WHERE id = $1 AND league_id = $2 AND user_id = $3
      RETURNING ${RETURNING}`,
    [notificationId, leagueId, userId],
  );
  if (!rows[0]) throw new FantasyError('NOT_FOUND', 'Notification not found');
  return toNotification(rows[0]);
}
