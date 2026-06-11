/**
 * Fantasy Street item 04 — the weekly lineup lock job.
 *
 * Run from jobs/scheduler.ts at the scoring week's market open (≈14:30 UTC) on
 * the first NYSE trading day of the week, under a Redis lock. For every active
 * league and every manager it: ensures a lineup row, auto-fills any empty
 * mandatory slot from the roster (autofill.ts), stamps locked_at, flags
 * auto_filled where it added slots, and publishes a `lineup.locked` event. Edits
 * after the stamp are rejected by setLineup (409 LINEUP_LOCKED).
 *
 * DoD bullet 4 ("a holiday Monday does not lock; lock occurs on the correct
 * open") is why the cron is Mon–Fri gated on `isFirstTradingDayOfWeek`, not a
 * Monday-only skip: a holiday Monday simply shifts the lock to Tuesday's open.
 */
import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import { isNyseHoliday } from '../market/holidays.js';
import { publishLineupLocked } from '../events/publisher.js';
import { ensureLineupRow, fillAndPersist, loadRosterConfig } from './lineup.js';

// Fixed UTC-5 (ET standard) offset, matching holidays.ts. The lock cron fires at
// ~14:30 UTC, well clear of the midnight boundary, so the ET date is stable.
const ET_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A weekday the NYSE is open (not a weekend, not an observed holiday). */
function isTradingDay(d: Date): boolean {
  const et = new Date(d.getTime() - ET_OFFSET_MS);
  const dow = et.getUTCDay(); // 0 = Sun … 6 = Sat, in ET
  if (dow === 0 || dow === 6) return false;
  return !isNyseHoliday(d);
}

/**
 * True when `now` is a trading day and every earlier weekday of the same week
 * was closed — i.e. this is the week's first market open, the moment lineups
 * lock. A holiday Monday defers the lock to the next open (Tue, …).
 */
export function isFirstTradingDayOfWeek(now: Date): boolean {
  if (!isTradingDay(now)) return false;
  const et = new Date(now.getTime() - ET_OFFSET_MS);
  const sinceMonday = (et.getUTCDay() + 6) % 7; // Mon→0, Tue→1, …
  for (let back = 1; back <= sinceMonday; back++) {
    if (isTradingDay(new Date(now.getTime() - back * DAY_MS))) return false;
  }
  return true;
}

/**
 * Lock a single manager's lineup within an open transaction: auto-fill empties,
 * stamp locked_at. Returns the lock outcome, or null if already locked (a
 * re-fire is idempotent). Caller owns the transaction and publishes the event.
 */
async function lockOne(
  client: PoolClient,
  leagueId: string,
  userId: string,
  season: number,
  week: number,
  now: Date,
): Promise<{ autoFilled: boolean } | null> {
  const row = await ensureLineupRow(
    client,
    leagueId,
    userId,
    season,
    week,
    true,
  );
  if (row.locked_at != null) return null;
  const cfg = await loadRosterConfig(client, leagueId);
  const added = await fillAndPersist(client, row.id, leagueId, userId, cfg);
  await client.query(
    `UPDATE fs_lineup
        SET locked_at = $2, auto_filled = auto_filled OR $3, updated_at = now()
      WHERE id = $1`,
    [row.id, now, added > 0],
  );
  return { autoFilled: row.auto_filled || added > 0 };
}

export interface LockResult {
  /** Lineups newly locked this run (excludes already-locked re-fires). */
  locked: number;
  autoFilled: number;
}

/**
 * Lock the given scoring week across every active league. Idempotent: an already
 * locked lineup is skipped. `redis`, when present, receives a `lineup.locked`
 * event per newly locked manager (after commit). Returns counts for telemetry.
 */
export async function lockLineups(
  pool: Pool,
  opts: { week: number; season?: number; now?: Date },
  redis?: Redis,
): Promise<LockResult> {
  const season = opts.season ?? 1;
  const week = opts.week;
  const now = opts.now ?? new Date();

  const { rows: members } = await pool.query<{
    league_id: string;
    user_id: string;
  }>(
    `SELECT m.league_id, m.user_id
       FROM fs_league_member m
       JOIN fs_league l ON l.id = m.league_id
      WHERE l.status = 'active'
      ORDER BY m.league_id, m.user_id`,
  );

  const result: LockResult = { locked: 0, autoFilled: 0 };
  for (const m of members) {
    const client = await pool.connect();
    let outcome: { autoFilled: boolean } | null = null;
    try {
      await client.query('BEGIN');
      outcome = await lockOne(
        client,
        m.league_id,
        m.user_id,
        season,
        week,
        now,
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    if (!outcome) continue; // already locked
    result.locked += 1;
    if (outcome.autoFilled) result.autoFilled += 1;
    if (redis) {
      await publishLineupLocked(redis, {
        leagueId: m.league_id,
        userId: m.user_id,
        season,
        week,
        autoFilled: outcome.autoFilled,
      });
    }
  }
  return result;
}
