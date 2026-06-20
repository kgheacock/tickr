/**
 * Fantasy Street item 11 — weekly recap generation.
 *
 * Run in-process from the scoring job (jobs/scoring.ts), once per league right
 * after the week is scored, under the scoring lock. For each manager it composes
 * a recap from the FS-05 per-slot breakdown (biggest mover = top-scoring started
 * slot, biggest blowup = most-negative) and the manager's weekly ranking
 * (placement among the league's managers this week), plus the league high/low,
 * and upserts it as a `recap` notification. Idempotent: a re-score re-runs this,
 * overwriting the recap in place (upsertRecap clears read_at so the correction
 * re-surfaces).
 *
 * The composing core (buildRecap) is pure for testing; generateLeagueRecaps is
 * the DB orchestration.
 */
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { RecapPayload, RecapSlot, WeeklyScore } from '@tickr/shared-types';
import { loadLeagueScores, rankScores } from './score.js';
import { upsertRecap } from './notifications.js';
import { publishNotification, publishRecapReady } from '../events/publisher.js';

/**
 * Compose one manager's recap. Pure: takes the manager's settled score, their
 * weekly rank and the field size, and every manager's score for the league
 * high/low (the caller passes them sorted high→low). The mover/blowup are the
 * extreme started slots by points; a manager who started nothing gets nulls.
 */
export function buildRecap(
  userId: string,
  season: number,
  week: number,
  myScore: WeeklyScore,
  rank: number,
  fieldSize: number,
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

  return {
    season,
    week,
    rank,
    fieldSize,
    myScore: myScore.totalPoints,
    biggestMover: mover,
    biggestBlowup: blowup,
    leagueHigh: { userId: high.userId, totalPoints: high.totalPoints },
    leagueLow: { userId: low.userId, totalPoints: low.totalPoints },
  };
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
  const ranks = rankScores(scores);
  const fieldSize = scores.length;

  let count = 0;
  for (const s of scores) {
    const payload = buildRecap(
      s.userId,
      season,
      week,
      s,
      ranks.get(s.userId) ?? fieldSize,
      fieldSize,
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
