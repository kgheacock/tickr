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
import { generateLeagueRecaps } from '../fantasy/recap.js';
import {
  publishScoreUpdated,
  publishMatchupUpdated,
  publishSeasonChampion,
} from '../events/publisher.js';
import { massiveGet } from '../massive/client.js';
import { insertBars } from './insertBars.js';
import { aggPath, MAX_RESULTS } from './granularity.js';
import { jobLogger } from '../log/logger.js';
import type { components } from '../massive/massive.gen.js';

type AggregatesResponse = components['schemas']['AggregatesResponse'];

const captureLog = jobLogger('scoring-capture');
const DAY_MS = 24 * 60 * 60 * 1000;
// Trailing window fetched per symbol — wide enough to span a long holiday gap so
// the settle always lands the just-closed Friday bar (idempotent ON CONFLICT).
const CAPTURE_LOOKBACK_DAYS = 5;

export interface ScoringJobOptions {
  week: number;
  season?: number;
  /** The scoring week's Friday — the return baseline + settle anchor. */
  weekEnd: Date;
  /** Explicit prior-week close anchor (settle path); default `weekEnd − 7d`. */
  baselineAt?: Date;
  /** True for the in-week provisional push; false for the Friday settle. */
  provisional?: boolean;
  /** Cap the "this" close for provisional scoring; default now. */
  asOf?: Date;
}

/**
 * Distinct symbols started in any active league's locked lineup for this week —
 * the exact set the settle will score. Bounded (dozens across all leagues), not
 * the ~500-symbol universe, so a settle-time fetch is cheap.
 */
async function rosteredSymbols(
  pool: Pool,
  season: number,
  week: number,
): Promise<string[]> {
  const { rows } = await pool.query<{ symbol: string }>(
    // Mirror activeLeagueIds: playoff weeks are scored too, so capture their
    // rostered symbols' close bars as well.
    `SELECT DISTINCT ls.symbol
       FROM fs_lineup l
       JOIN fs_lineup_slot ls ON ls.lineup_id = l.id
       JOIN fs_league lg ON lg.id = l.league_id
      WHERE lg.status IN ('active', 'playoffs')
        AND l.season = $1 AND l.week = $2
        AND ls.slot <> 'bench'
      ORDER BY ls.symbol`,
    [season, week],
  );
  return rows.map((r) => r.symbol);
}

/**
 * Pull the just-closed session's bars for exactly the rostered symbols so every
 * lineup is valued off the *same* point in the trading day. The session-gated
 * intraday tail stops at 16:00 ET and may not have swept every symbol's final
 * bar by settle (and a naive "latest bar" would otherwise drift into uneven
 * after-hours prints) — this guarantees the close bar is present for all scored
 * symbols. Best-effort + idempotent: a per-symbol failure is logged and skipped
 * rather than aborting the settle (those slots fall back to their last close).
 */
async function captureCloseBars(
  pool: Pool,
  redis: Redis,
  season: number,
  week: number,
): Promise<void> {
  const symbols = await rosteredSymbols(pool, season, week);
  if (symbols.length === 0) return;

  const nowMs = Date.now();
  const from = new Date(nowMs - CAPTURE_LOOKBACK_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const to = new Date(nowMs).toISOString().slice(0, 10);

  let captured = 0;
  for (const symbol of symbols) {
    try {
      const res = await massiveGet<AggregatesResponse>(
        redis,
        aggPath(symbol, from, to),
        { sort: 'asc', limit: MAX_RESULTS },
      );
      const results = res.results ?? [];
      if (results.length > 0) {
        await insertBars(symbol, results);
        captured += 1;
      }
    } catch (err) {
      captureLog.warn(
        { symbol, err: String(err) },
        'close-bar capture failed for symbol — settling off last close',
      );
    }
  }
  captureLog.info({ symbols: symbols.length, captured }, 'close capture done');
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

  // Settle only: pull the just-closed bars for the rostered symbols up front so
  // every league is valued off the same close (the intraday tail may not have
  // swept them all by now). Best-effort — never blocks the settle if it fails.
  // This is the one external-data hop on the settle path (Massive), so it honors
  // the same TICKR_DISABLE_REMOTE_JOBS dev guard the scheduler applies to every
  // other external-data job; with it set, the settle still runs off whatever bars
  // already exist. NEVER set in prod (deploy.sh refuses it).
  const remoteJobsDisabled = process.env['TICKR_DISABLE_REMOTE_JOBS'] === '1';
  if (!provisional && redis && !remoteJobsDisabled) {
    await captureCloseBars(pool, redis, season, opts.week);
  }

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
          ...(opts.baselineAt ? { baselineAt: opts.baselineAt } : {}),
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
      // FS-11: compose each manager's weekly recap from the just-settled
      // scores + matchups. After settleMatchups so results are final;
      // idempotent (upsert) so a re-score regenerates them cleanly. Best-effort
      // and isolated: recaps are the lowest-criticality consumer, so a failure
      // here must never abort the settle or block this/other leagues' publishes
      // (the scores are already persisted) — log and carry on.
      try {
        await generateLeagueRecaps(pool, leagueId, season, opts.week, redis);
      } catch (err) {
        captureLog.warn(
          { leagueId, week: opts.week, err: String(err) },
          'recap generation failed — settle stands, recaps deferred',
        );
      }
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
