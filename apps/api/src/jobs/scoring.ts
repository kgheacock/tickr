/**
 * Fantasy Street item 05 — the weekly scoring job.
 *
 * Run from jobs/scheduler.ts under a Redis lock. Two modes over every active
 * league:
 *
 *   settle (Friday post-close)  — compute each manager's score from the Friday
 *       close, persist it (idempotent upsert), publish `score.updated` (FS-06
 *       settles the matchup off this), and push the final `matchup.updated`.
 *   provisional (Mon–Thu)       — compute a best-effort total from the latest
 *       available close and push `matchup.updated` without persisting.
 *
 * Thin orchestration; all scoring math lives in fantasy/score.ts.
 */
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { computeLeagueWeek, settleLeagueWeek } from '../fantasy/score.js';
import { settleMatchups } from '../fantasy/settle.js';
import {
  publishScoreUpdated,
  publishMatchupUpdated,
  publishSeasonChampion,
} from '../events/publisher.js';

export interface ScoringJobOptions {
  week: number;
  season?: number;
  /** The scoring week's Friday — the return baseline + settle anchor. */
  weekEnd: Date;
  /** True for the in-week provisional push; false for the Friday settle. */
  provisional?: boolean;
  /** Cap the "this" close for provisional scoring; default now. */
  asOf?: Date;
}

export interface ScoringResult {
  /** Active leagues processed. */
  leagues: number;
  /** Manager-score rows computed across those leagues. */
  scores: number;
}

/**
 * Leagues to score this run. `playoffs` are included (FS-08): the bracket's
 * matchups settle off the same weekly scores, so a playoff week must still be
 * scored — otherwise games tie 0–0 and advance on seed alone.
 */
async function activeLeagueIds(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM fs_league
      WHERE status IN ('active', 'playoffs') ORDER BY id`,
  );
  return rows.map((r) => r.id);
}

/**
 * Score every active league for the given week. Persists + publishes on settle;
 * publishes provisional totals otherwise. `redis`, when present, receives the
 * events (after commit). Returns counts for telemetry.
 */
export async function runWeeklyScoring(
  pool: Pool,
  opts: ScoringJobOptions,
  redis?: Redis,
): Promise<ScoringResult> {
  const season = opts.season ?? 1;
  const provisional = opts.provisional ?? false;
  const leagues = await activeLeagueIds(pool);

  const result: ScoringResult = { leagues: 0, scores: 0 };
  for (const leagueId of leagues) {
    const scores = provisional
      ? await computeLeagueWeek(pool, {
          leagueId,
          season,
          week: opts.week,
          weekEnd: opts.weekEnd,
          asOf: opts.asOf ?? new Date(),
          provisional: true,
        })
      : await settleLeagueWeek(pool, {
          leagueId,
          season,
          week: opts.week,
          weekEnd: opts.weekEnd,
        });

    result.leagues += 1;
    result.scores += scores.length;

    // FS-06: settle this week's head-to-head matchups off the just-persisted
    // scores and rebuild standings. In-process (not off the score.updated echo)
    // so a settle is never dropped, and durable — outside the redis guard.
    // FS-08: the settle also drives the season→playoffs transition and crowns a
    // champion when the final settles.
    let champion: string | null = null;
    if (!provisional) {
      const settle = await settleMatchups(pool, leagueId, opts.week, season);
      champion = settle.championUserId;
    }

    if (redis) {
      if (!provisional) {
        await publishScoreUpdated(redis, { leagueId, season, week: opts.week });
        if (champion) {
          await publishSeasonChampion(redis, {
            leagueId,
            season,
            championUserId: champion,
          });
        }
      }
      await publishMatchupUpdated(
        redis,
        leagueId,
        season,
        opts.week,
        scores,
        provisional,
      );
    }
  }
  return result;
}
