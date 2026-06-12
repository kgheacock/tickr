/**
 * Fantasy Street item 05 — weekly scoring.
 *
 * Pure, pool-driven domain (no Redis, no timers): turn a manager's locked,
 * started lineup into a weekly point total plus a per-slot breakdown, and
 * persist/read it. The Friday post-close job (jobs/scoring.ts) drives the
 * settle; the HTTP glue is routes/leagues/scores.ts. Everything testable lives
 * here — see test/fantasy/score.test.ts.
 *
 * Scoring rules (canonical; epic README → "Scoring rules"):
 *   long slot points    =  r × 10
 *   defense (short) pts  = −r × 10        (positive when the shorted stock falls)
 *   weekly total         = Σ started (non-bench) slots — uncapped, losses in full
 * where r is the week's percent return (returns.ts). A slot whose return can't
 * be resolved scores 0. Each slot's points are rounded to 2 decimals, then the
 * total sums those rounded values — so `breakdown` sums exactly to `totalPoints`.
 */
import type { Pool, PoolClient } from 'pg';
import type { ScoreBreakdownItem, WeeklyScore } from '@tickr/shared-types';
import { weeklyReturn } from './returns.js';

/** Cosmetic points-per-percent scale (locked decision; open question #5). */
const POINTS_SCALE = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Points for one started slot: r×10 long, −r×10 short; 0 when r is unknown. */
function slotPoints(returnPct: number | null, isShort: boolean): number {
  if (returnPct == null) return 0;
  const base = returnPct * POINTS_SCALE;
  return round2(isShort ? -base : base);
}

interface StartedSlot {
  slot: string;
  symbol: string;
  is_short: boolean;
}

export interface ScoreWeekOptions {
  leagueId: string;
  week: number;
  season?: number;
  /** The scoring week's Friday — the baseline + "this" close anchor. */
  weekEnd: Date;
  /** Cap the "this" close for provisional in-week scoring; default `weekEnd`. */
  asOf?: Date;
  /** Explicit prior-week close anchor (settle path); default `weekEnd − 7d`. */
  baselineAt?: Date;
  /** True for an in-week provisional total (not yet settled at Friday close). */
  provisional?: boolean;
}

/** Started (non-bench) slots of one manager's lineup for the week. */
async function loadStartedSlots(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
  season: number,
  week: number,
): Promise<StartedSlot[]> {
  const { rows } = await db.query<StartedSlot>(
    `SELECT ls.slot, ls.symbol, ls.is_short
       FROM fs_lineup l
       JOIN fs_lineup_slot ls ON ls.lineup_id = l.id
      WHERE l.league_id = $1 AND l.user_id = $2
        AND l.season = $3 AND l.week = $4
        AND ls.slot <> 'bench'
      ORDER BY ls.slot, ls.slot_index`,
    [leagueId, userId, season, week],
  );
  return rows;
}

/**
 * Compute one manager's weekly score from their started lineup. Pure read — no
 * persistence; the settle path and the provisional path share it.
 */
export async function computeManagerScore(
  db: Pool | PoolClient,
  userId: string,
  opts: ScoreWeekOptions,
): Promise<WeeklyScore> {
  const season = opts.season ?? 1;
  const asOf = opts.asOf ?? opts.weekEnd;
  const started = await loadStartedSlots(
    db,
    opts.leagueId,
    userId,
    season,
    opts.week,
  );

  const breakdown: ScoreBreakdownItem[] = [];
  let total = 0;
  for (const s of started) {
    const r = await weeklyReturn(db, s.symbol, opts.weekEnd, asOf, opts.baselineAt);
    const points = slotPoints(r.returnPct, s.is_short);
    total += points;
    breakdown.push({
      // slot is DB-constrained to the enum (fs_lineup_slot CHECK).
      slot: s.slot as ScoreBreakdownItem['slot'],
      symbol: s.symbol,
      isShort: s.is_short,
      lastClose: r.lastClose,
      thisClose: r.thisClose,
      returnPct: r.returnPct == null ? null : round2(r.returnPct),
      points,
    });
  }

  return {
    leagueId: opts.leagueId,
    userId,
    season,
    week: opts.week,
    totalPoints: round2(total),
    computedAt: new Date().toISOString(),
    provisional: opts.provisional ?? false,
    breakdown,
  };
}

/** The managers (one per lineup) to score for a (league, season, week). */
async function lineupManagers(
  db: Pool | PoolClient,
  leagueId: string,
  season: number,
  week: number,
): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM fs_lineup
      WHERE league_id = $1 AND season = $2 AND week = $3
      ORDER BY user_id`,
    [leagueId, season, week],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Compute every manager's weekly score for one league (no persistence). Used by
 * the settle (asOf = weekEnd) and the provisional in-week path (asOf = now).
 */
export async function computeLeagueWeek(
  db: Pool | PoolClient,
  opts: ScoreWeekOptions,
): Promise<WeeklyScore[]> {
  const season = opts.season ?? 1;
  const managers = await lineupManagers(db, opts.leagueId, season, opts.week);
  const scores: WeeklyScore[] = [];
  for (const userId of managers) {
    scores.push(await computeManagerScore(db, userId, { ...opts, season }));
  }
  return scores;
}

/** Idempotent upsert of a settled weekly score (re-scoring overwrites). */
async function upsertScore(
  db: Pool | PoolClient,
  s: WeeklyScore,
): Promise<void> {
  await db.query(
    `INSERT INTO fs_weekly_score
       (league_id, user_id, season, week, total_points, breakdown, computed_at,
        season_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(),
             (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = $3))
     ON CONFLICT (league_id, user_id, season, week)
     DO UPDATE SET total_points = EXCLUDED.total_points,
                   breakdown    = EXCLUDED.breakdown,
                   computed_at  = now()`,
    [
      s.leagueId,
      s.userId,
      s.season,
      s.week,
      s.totalPoints,
      JSON.stringify(s.breakdown),
    ],
  );
}

/**
 * Settle a league's just-closed week: compute every manager's score from the
 * Friday close and persist it (idempotent upsert). Returns the settled scores;
 * the caller publishes `score.updated`. Provisional is always false here.
 */
export async function settleLeagueWeek(
  pool: Pool,
  opts: ScoreWeekOptions,
): Promise<WeeklyScore[]> {
  const scores = await computeLeagueWeek(pool, {
    ...opts,
    asOf: opts.weekEnd,
    provisional: false,
  });
  for (const s of scores) await upsertScore(pool, s);
  return scores;
}

// --- Read path (FS-06 matchups / FS-11 recaps read these) -------------------

interface ScoreRow {
  league_id: string;
  user_id: string;
  season: number;
  week: number;
  total_points: number;
  breakdown: ScoreBreakdownItem[];
  computed_at: Date;
}

function toWeeklyScore(r: ScoreRow): WeeklyScore {
  return {
    leagueId: r.league_id,
    userId: r.user_id,
    season: r.season,
    week: r.week,
    // total_points is NUMERIC → cast to float8 in SQL so node-pg yields a number.
    totalPoints: r.total_points,
    computedAt: r.computed_at.toISOString(),
    provisional: false,
    breakdown: r.breakdown,
  };
}

/** A single manager's settled score for the week, or null if not yet scored. */
export async function loadWeeklyScore(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
  week: number,
  season = 1,
): Promise<WeeklyScore | null> {
  const { rows } = await db.query<ScoreRow>(
    `SELECT league_id, user_id, season, week,
            total_points::float8 AS total_points, breakdown, computed_at
       FROM fs_weekly_score
      WHERE league_id = $1 AND user_id = $2 AND season = $3 AND week = $4`,
    [leagueId, userId, season, week],
  );
  return rows[0] ? toWeeklyScore(rows[0]) : null;
}

/** Every manager's settled score for a league week (standings/matchup source). */
export async function loadLeagueScores(
  db: Pool | PoolClient,
  leagueId: string,
  week: number,
  season = 1,
): Promise<WeeklyScore[]> {
  const { rows } = await db.query<ScoreRow>(
    `SELECT league_id, user_id, season, week,
            total_points::float8 AS total_points, breakdown, computed_at
       FROM fs_weekly_score
      WHERE league_id = $1 AND season = $2 AND week = $3
      ORDER BY total_points DESC, user_id`,
    [leagueId, season, week],
  );
  return rows.map(toWeeklyScore);
}
