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
import { loadSeason } from './season.js';
import { materializeBracket } from './playoffs.js';

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
      WHERE league_id = $1 AND season = $2 AND is_playoff = false`,
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
 * FS-08 season transition, run inside the settle transaction after standings
 * are rebuilt. When the last regular week settles, the season flips to
 * `playoffs` (league too) and the bracket is seeded; on each playoff week it
 * advances, crowning a champion when the final settles. Idempotent — re-running
 * a week is a no-op once past the relevant edge. Returns what changed so the
 * caller can publish `season.champion`.
 */
async function runSeasonTransition(
  db: PoolClient,
  leagueId: string,
  season: number,
  week: number,
): Promise<{ enteredPlayoffs: boolean; championUserId: string | null }> {
  const seasonRow = await loadSeason(db, leagueId, season);
  if (!seasonRow) return { enteredPlayoffs: false, championUserId: null };

  let enteredPlayoffs = false;
  if (seasonRow.status === 'regular' && week >= seasonRow.regular_weeks) {
    await db.query(`UPDATE fs_season SET status = 'playoffs' WHERE id = $1`, [
      seasonRow.id,
    ]);
    await db.query(`UPDATE fs_league SET status = 'playoffs' WHERE id = $1`, [
      leagueId,
    ]);
    seasonRow.status = 'playoffs';
    enteredPlayoffs = true;
  }

  if (seasonRow.status === 'playoffs') {
    const championUserId = await materializeBracket(db, leagueId, seasonRow);
    return { enteredPlayoffs, championUserId };
  }
  return { enteredPlayoffs, championUserId: null };
}

export interface SettleResult {
  /** Matchups settled this week (regular + playoff). */
  settled: number;
  /** True when this settle flipped the season into the playoffs. */
  enteredPlayoffs: boolean;
  /** The champion crowned by this settle, else null. */
  championUserId: string | null;
}

/**
 * Settle a league's just-scored week and rebuild its standings. Reads the
 * persisted fs_weekly_score totals (a missing manager scores 0), decides each
 * matchup, flips it `final`, recomputes the standings cache (regular-season
 * games only), then runs the FS-08 season transition — all in one transaction.
 */
export async function settleMatchups(
  pool: Pool,
  leagueId: string,
  week: number,
  season = 1,
): Promise<SettleResult> {
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
    const transition = await runSeasonTransition(
      client,
      leagueId,
      season,
      week,
    );
    await client.query('COMMIT');
    return { settled: matchups.length, ...transition };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
