/**
 * Fantasy Street item 06 — the season schedule (round-robin generator).
 *
 * Pure circle-method round-robin plus a thin idempotent DB insert. The schedule
 * is generated once, when the draft completes (driven in-process from
 * draftClock.broadcastPick — not a Redis subscriber, so a missed pub/sub echo
 * can never leave a league unscheduled). Re-running is a no-op once any matchup
 * row exists for the (league, season). The pairing math is pure and lives here;
 * see test/fantasy/schedule.test.ts.
 */
import type { Pool, PoolClient } from 'pg';
import { resolveSeasonId } from './season.js';

export interface Pairing {
  home: string;
  /** NULL = the home manager has a bye this week (odd league size). */
  away: string | null;
}

/**
 * Circle-method round-robin over `managerIds`, extended to `weeks` weeks. The
 * caller passes a stable order (we order by user_id) so the output is
 * deterministic and re-runs reproduce identical pairings. An odd count adds a
 * rotating bye — exactly one manager is paired with `null` each week. Within one
 * full cycle (`n-1` weeks for even `n`, `n` for odd) every pair meets exactly
 * once; longer seasons wrap the rotation, swapping home/away each cycle so a
 * repeated pairing alternates venue.
 */
export function roundRobinSchedule(
  managerIds: string[],
  weeks: number,
): Pairing[][] {
  if (managerIds.length < 2 || weeks < 1) return [];

  // Pad to an even count with a bye sentinel (null) so every seat is paired.
  const seats: (string | null)[] = [...managerIds];
  if (seats.length % 2 === 1) seats.push(null);
  const n = seats.length;
  const rounds = n - 1; // distinct rounds in one full cycle
  const half = n / 2;

  // Build one full cycle. seats[0] is fixed; the rest rotate clockwise.
  let arr = [...seats];
  const cycle: Pairing[][] = [];
  for (let r = 0; r < rounds; r++) {
    const pairings: Pairing[] = [];
    for (let i = 0; i < half; i++) {
      const a = arr[i]!;
      const b = arr[n - 1 - i]!;
      if (a === null) pairings.push({ home: b!, away: null });
      else if (b === null) pairings.push({ home: a, away: null });
      else pairings.push({ home: a, away: b });
    }
    cycle.push(pairings);
    // Rotate everything but the fixed first seat: [0, last, 1, 2, …, last-1].
    arr = [arr[0]!, arr[n - 1]!, ...arr.slice(1, n - 1)];
  }

  // Repeat the cycle out to `weeks`; swap home/away on each subsequent cycle.
  const schedule: Pairing[][] = [];
  for (let w = 0; w < weeks; w++) {
    const swap = Math.floor(w / rounds) % 2 === 1;
    const base = cycle[w % rounds]!;
    schedule.push(
      base.map((p) =>
        p.away === null || !swap ? p : { home: p.away, away: p.home },
      ),
    );
  }
  return schedule;
}

/** Members (managers) of a league, in a stable order for the round-robin. */
async function leagueManagers(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM fs_league_member
      WHERE league_id = $1 ORDER BY user_id`,
    [leagueId],
  );
  return rows.map((r) => r.user_id);
}

/** A league's season length (weeks); the round-robin is generated this long. */
async function seasonLength(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<number | null> {
  const { rows } = await db.query<{ season_length_weeks: number }>(
    `SELECT season_length_weeks FROM fs_league WHERE id = $1`,
    [leagueId],
  );
  return rows[0]?.season_length_weeks ?? null;
}

/**
 * Generate and persist the full-season round-robin for a league. Idempotent per
 * (league, season): if any matchup already exists it returns 0 without touching
 * the schedule (so a re-fired draft.complete, or two api instances, can't
 * double-insert). Returns the number of matchup rows written.
 */
export async function generateSchedule(
  pool: Pool,
  leagueId: string,
  season = 1,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: existing } = await client.query(
      `SELECT 1 FROM fs_matchup
        WHERE league_id = $1 AND season = $2 LIMIT 1`,
      [leagueId, season],
    );
    if (existing.length > 0) {
      await client.query('ROLLBACK');
      return 0;
    }

    const [managers, weeks, seasonId] = await Promise.all([
      leagueManagers(client, leagueId),
      seasonLength(client, leagueId),
      resolveSeasonId(client, leagueId, season),
    ]);
    // No season row means draft.complete didn't open the season first — the
    // matchup FK to fs_season would fail, so bail rather than half-schedule.
    if (managers.length < 2 || !weeks || !seasonId) {
      await client.query('ROLLBACK');
      return 0;
    }

    const schedule = roundRobinSchedule(managers, weeks);
    let inserted = 0;
    for (let w = 0; w < schedule.length; w++) {
      const week = w + 1;
      for (const p of schedule[w]!) {
        await client.query(
          `INSERT INTO fs_matchup
             (league_id, season, season_id, week, home_user_id, away_user_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
           ON CONFLICT (league_id, season, week, home_user_id) DO NOTHING`,
          [leagueId, season, seasonId, week, p.home, p.away],
        );
        inserted += 1;
      }
    }

    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
