/**
 * Fantasy Street — season win standings.
 *
 * The game is weekly-ranking-only (FS-06 superseded): there are no head-to-head
 * matchups, so a "win" is simply a first-place finish in a settled week's
 * ranking. This module tallies those wins across every settled week of a season
 * to produce the dashboard's season-long leaderboard.
 *
 * `tallyWins` is the pure core (testable off constructed scores); `loadSeasonWins`
 * is the DB orchestration that reads the settled `fs_weekly_score` rows. Wins are
 * always derived from those scores, never stored — re-scoring a week re-derives
 * the standings for free.
 */
import type { Pool, PoolClient } from 'pg';
import type { SeasonWinsEntry, WeeklyScore } from '@tickr/shared-types';
import { rankScores } from './score.js';

/**
 * Tally first-place finishes per manager across a season's settled weeks.
 *
 * Scores from any number of weeks may be mixed in; they are grouped by week and
 * each week is ranked with the shared `rankScores`, so the win definition is
 * identical to the live weekly board. Co-leaders (a tie at the top) each count a
 * win — there is no single-winner tiebreak within a week. Entries come back
 * ordered by wins, then total points-for (the documented tiebreaker), then
 * userId for stability.
 *
 * Returns the ordered entries plus the number of distinct weeks counted.
 */
export function tallyWins(scores: WeeklyScore[]): {
  weeks: number;
  entries: SeasonWinsEntry[];
} {
  const byWeek = new Map<number, WeeklyScore[]>();
  for (const s of scores) {
    const bucket = byWeek.get(s.week);
    if (bucket) bucket.push(s);
    else byWeek.set(s.week, [s]);
  }

  const tally = new Map<
    string,
    { wins: number; weeksPlayed: number; pointsFor: number }
  >();
  const bump = (userId: string) => {
    let agg = tally.get(userId);
    if (!agg) {
      agg = { wins: 0, weeksPlayed: 0, pointsFor: 0 };
      tally.set(userId, agg);
    }
    return agg;
  };

  for (const weekScores of byWeek.values()) {
    const ranks = rankScores(weekScores);
    for (const s of weekScores) {
      const agg = bump(s.userId);
      agg.weeksPlayed += 1;
      agg.pointsFor += s.totalPoints;
      if (ranks.get(s.userId) === 1) agg.wins += 1;
    }
  }

  const entries: SeasonWinsEntry[] = [...tally.entries()]
    .map(([userId, agg]) => ({
      userId,
      wins: agg.wins,
      weeksPlayed: agg.weeksPlayed,
      // Re-round the running sum so it matches the 2dp weekly totals exactly.
      pointsFor: Math.round(agg.pointsFor * 100) / 100,
    }))
    .sort(
      (a, b) =>
        b.wins - a.wins ||
        b.pointsFor - a.pointsFor ||
        (a.userId < b.userId ? -1 : 1),
    );

  return { weeks: byWeek.size, entries };
}

/** Every settled score for a season, across all weeks — the win tally source. */
async function loadSeasonScores(
  db: Pool | PoolClient,
  leagueId: string,
  season: number,
): Promise<WeeklyScore[]> {
  const { rows } = await db.query<{
    user_id: string;
    week: number;
    total_points: number;
  }>(
    `SELECT user_id, week, total_points::float8 AS total_points
       FROM fs_weekly_score
      WHERE league_id = $1 AND season = $2`,
    [leagueId, season],
  );
  // tallyWins only reads userId, week and totalPoints, so we hydrate just those.
  return rows.map((r) => ({
    leagueId,
    userId: r.user_id,
    season,
    week: r.week,
    totalPoints: r.total_points,
    provisional: false,
    computedAt: '',
    breakdown: [],
  }));
}

/** Season win standings for a league, derived from its settled weekly scores. */
export async function loadSeasonWins(
  db: Pool | PoolClient,
  leagueId: string,
  season = 1,
): Promise<{ weeks: number; entries: SeasonWinsEntry[] }> {
  const scores = await loadSeasonScores(db, leagueId, season);
  return tallyWins(scores);
}
