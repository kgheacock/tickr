/**
 * Fantasy Street item 06 — matchup settlement.
 *
 * When a league's week is scored (FS-05 persists fs_weekly_score and the
 * scoring job calls this in-process, post-commit, under the scoring lock — not
 * via a Redis subscriber, so a settle can never be silently dropped), fill each
 * matchup's points from the weekly scores, decide the winner (higher total; tie
 * if equal), flip it to `final`, then rebuild the fs_standings cache. Idempotent
 * off fs_weekly_score: a re-scored week (FS-12 dispute) re-settles and re-ranks.
 *
 * A bye (away_user_id NULL) is a no-contest: its home points are recorded for
 * display, but it has no winner and does not move standings (see standings.ts).
 */
import type { Pool, PoolClient } from 'pg';
import { computeStandings, type StandingMatchup } from './standings.js';

/** Higher total wins; equal totals tie (null). Pure — the testable core. */
export function decideWinner(
  homeUserId: string,
  awayUserId: string,
  homePoints: number,
  awayPoints: number,
): string | null {
  if (homePoints > awayPoints) return homeUserId;
  if (awayPoints > homePoints) return awayUserId;
  return null;
}

interface MatchupRow {
  id: string;
  home_user_id: string;
  away_user_id: string | null;
}

/** Every manager's settled total for the (league, season, week), as a map. */
async function weeklyScoreMap(
  db: PoolClient,
  leagueId: string,
  season: number,
  week: number,
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ user_id: string; total_points: number }>(
    `SELECT user_id, total_points::float8 AS total_points
       FROM fs_weekly_score
      WHERE league_id = $1 AND season = $2 AND week = $3`,
    [leagueId, season, week],
  );
  return new Map(rows.map((r) => [r.user_id, r.total_points]));
}

/** Rebuild the fs_standings cache for a league from its final matchups. */
async function rebuildStandings(
  db: PoolClient,
  leagueId: string,
  season: number,
): Promise<void> {
  const { rows: members } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM fs_league_member WHERE league_id = $1`,
    [leagueId],
  );
  const { rows: matchups } = await db.query<{
    home_user_id: string;
    away_user_id: string | null;
    home_points: number | null;
    away_points: number | null;
    winner_user_id: string | null;
    status: 'scheduled' | 'final';
  }>(
    `SELECT home_user_id, away_user_id,
            home_points::float8 AS home_points,
            away_points::float8 AS away_points,
            winner_user_id, status
       FROM fs_matchup
      WHERE league_id = $1 AND season = $2`,
    [leagueId, season],
  );

  const standings = computeStandings(
    members.map((m) => m.user_id),
    matchups.map(
      (m): StandingMatchup => ({
        homeUserId: m.home_user_id,
        awayUserId: m.away_user_id,
        homePoints: m.home_points,
        awayPoints: m.away_points,
        winnerUserId: m.winner_user_id,
        status: m.status,
      }),
    ),
  );

  // Rebuild from scratch — cheap (league-sized) and never leaves stale rows.
  await db.query(
    `DELETE FROM fs_standings WHERE league_id = $1 AND season = $2`,
    [leagueId, season],
  );
  for (const s of standings) {
    await db.query(
      `INSERT INTO fs_standings
         (league_id, season, user_id, wins, losses, ties,
          points_for, points_against, rank, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        leagueId,
        season,
        s.userId,
        s.wins,
        s.losses,
        s.ties,
        s.pointsFor,
        s.pointsAgainst,
        s.rank,
      ],
    );
  }
}

/**
 * Settle a league's just-scored week and rebuild its standings. Reads the
 * persisted fs_weekly_score totals (a missing manager scores 0), decides each
 * matchup, flips it `final`, and recomputes the standings cache — all in one
 * transaction. Returns the number of matchups settled.
 */
export async function settleMatchups(
  pool: Pool,
  leagueId: string,
  week: number,
  season = 1,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const scores = await weeklyScoreMap(client, leagueId, season, week);
    const { rows: matchups } = await client.query<MatchupRow>(
      `SELECT id, home_user_id, away_user_id
         FROM fs_matchup
        WHERE league_id = $1 AND season = $2 AND week = $3`,
      [leagueId, season, week],
    );

    for (const m of matchups) {
      const homePoints = scores.get(m.home_user_id) ?? 0;
      if (m.away_user_id === null) {
        // Bye: record the home total for display; no winner, no contest.
        await client.query(
          `UPDATE fs_matchup
              SET home_points = $2, away_points = NULL,
                  winner_user_id = NULL, status = 'final', updated_at = now()
            WHERE id = $1`,
          [m.id, homePoints],
        );
        continue;
      }
      const awayPoints = scores.get(m.away_user_id) ?? 0;
      const winner = decideWinner(
        m.home_user_id,
        m.away_user_id,
        homePoints,
        awayPoints,
      );
      await client.query(
        `UPDATE fs_matchup
            SET home_points = $2, away_points = $3,
                winner_user_id = $4, status = 'final', updated_at = now()
          WHERE id = $1`,
        [m.id, homePoints, awayPoints, winner],
      );
    }

    await rebuildStandings(client, leagueId, season);
    await client.query('COMMIT');
    return matchups.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
