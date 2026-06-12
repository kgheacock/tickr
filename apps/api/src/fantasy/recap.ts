/**
 * Fantasy Street item 11 — weekly recap generation.
 *
 * Run in-process from the scoring job (jobs/scoring.ts), once per league right
 * after the FS-06 settle, under the scoring lock. For each manager it composes a
 * recap from the FS-05 per-slot breakdown (biggest mover = top-scoring started
 * slot, biggest blowup = most-negative) and the FS-06 settled matchup (result,
 * my/opp score), plus the league high/low, and upserts it as a `recap`
 * notification. Idempotent: a re-score re-runs the settle and this, overwriting
 * the recap in place (upsertRecap clears read_at so the correction re-surfaces).
 *
 * The composing core (buildRecap) is pure for testing; generateLeagueRecaps is
 * the DB orchestration.
 */
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { RecapPayload, RecapSlot, WeeklyScore } from '@tickr/shared-types';
import { loadLeagueScores } from './score.js';
import { upsertRecap } from './notifications.js';
import { publishNotification, publishRecapReady } from '../events/publisher.js';

export interface RecapMatchup {
  homeUserId: string;
  awayUserId: string | null;
  homePoints: number | null;
  awayPoints: number | null;
  winnerUserId: string | null;
}

/**
 * Compose one manager's recap. Pure: takes the manager's settled score, their
 * matchup (null/bye allowed), and every manager's score for the league high/low
 * (the caller passes them sorted high→low). The mover/blowup are the extreme
 * started slots by points; a manager who started nothing gets nulls.
 */
export function buildRecap(
  userId: string,
  season: number,
  week: number,
  myScore: WeeklyScore,
  matchup: RecapMatchup | null,
  leagueScores: WeeklyScore[],
): RecapPayload {
  let mover: RecapSlot | null = null;
  let blowup: RecapSlot | null = null;
  for (const b of myScore.breakdown ?? []) {
    const slot: RecapSlot = {
      slot: b.slot,
      symbol: b.symbol,
      points: b.points,
    };
    if (mover === null || b.points > mover.points) mover = slot;
    if (blowup === null || b.points < blowup.points) blowup = slot;
  }

  // leagueScores is sorted total_points DESC (loadLeagueScores), so the first is
  // the high and the last is the low — both always present (≥ this manager).
  const high = leagueScores[0]!;
  const low = leagueScores[leagueScores.length - 1]!;

  const isBye =
    !matchup || (matchup.awayUserId === null && matchup.homeUserId === userId);

  let result: RecapPayload['result'];
  let oppUserId: string | null = null;
  let oppScore: number | null = null;
  if (isBye) {
    result = 'bye';
  } else {
    const iAmHome = matchup!.homeUserId === userId;
    oppUserId = iAmHome ? matchup!.awayUserId : matchup!.homeUserId;
    oppScore = iAmHome ? matchup!.awayPoints : matchup!.homePoints;
    if (matchup!.winnerUserId === userId) {
      result = 'win';
    } else if (
      matchup!.winnerUserId !== null &&
      matchup!.winnerUserId !== userId
    ) {
      result = 'loss';
    } else {
      // No recorded winner — a settled tie, or (defensively) decide by points.
      const mine = myScore.totalPoints;
      const theirs = oppScore ?? 0;
      result = mine > theirs ? 'win' : mine < theirs ? 'loss' : 'tie';
    }
  }

  return {
    season,
    week,
    result,
    myScore: myScore.totalPoints,
    oppScore,
    oppUserId,
    biggestMover: mover,
    biggestBlowup: blowup,
    leagueHigh: { userId: high.userId, totalPoints: high.totalPoints },
    leagueLow: { userId: low.userId, totalPoints: low.totalPoints },
  };
}

/** Map each manager (home and away) to their settled matchup for the week. */
async function matchupsByUser(
  pool: Pool,
  leagueId: string,
  season: number,
  week: number,
): Promise<Map<string, RecapMatchup>> {
  const { rows } = await pool.query<{
    home_user_id: string;
    away_user_id: string | null;
    home_points: number | null;
    away_points: number | null;
    winner_user_id: string | null;
  }>(
    `SELECT home_user_id, away_user_id,
            home_points::float8 AS home_points,
            away_points::float8 AS away_points,
            winner_user_id
       FROM fs_matchup
      WHERE league_id = $1 AND season = $2 AND week = $3`,
    [leagueId, season, week],
  );

  const byUser = new Map<string, RecapMatchup>();
  for (const r of rows) {
    const m: RecapMatchup = {
      homeUserId: r.home_user_id,
      awayUserId: r.away_user_id,
      homePoints: r.home_points,
      awayPoints: r.away_points,
      winnerUserId: r.winner_user_id,
    };
    byUser.set(r.home_user_id, m);
    if (r.away_user_id) byUser.set(r.away_user_id, m);
  }
  return byUser;
}

/**
 * Generate (or regenerate) the weekly recap for every scored manager in a
 * league and push each to its owner's live feed. Returns how many recaps were
 * written. A no-op when the week hasn't been scored yet.
 */
export async function generateLeagueRecaps(
  pool: Pool,
  leagueId: string,
  season: number,
  week: number,
  redis?: Redis,
): Promise<number> {
  const scores = await loadLeagueScores(pool, leagueId, week, season);
  if (scores.length === 0) return 0;
  const byUser = await matchupsByUser(pool, leagueId, season, week);

  let count = 0;
  for (const s of scores) {
    const payload = buildRecap(
      s.userId,
      season,
      week,
      s,
      byUser.get(s.userId) ?? null,
      scores,
    );
    const notification = await upsertRecap(pool, {
      leagueId,
      userId: s.userId,
      kind: 'recap',
      dedupeKey: `recap:${season}:${week}`,
      payload,
    });
    count += 1;
    if (redis) await publishNotification(redis, s.userId, notification);
  }

  if (redis) await publishRecapReady(redis, { leagueId, season, week });
  return count;
}
