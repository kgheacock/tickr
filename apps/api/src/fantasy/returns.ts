/**
 * Fantasy Street item 05 — weekly return resolver.
 *
 * Pure price-data lookup (no scoring, no Redis): given a symbol and the scoring
 * week's end (a Friday), resolve the week's percent return from `price_bar`:
 *
 *   r = (this Friday close − last Friday close) / last Friday close × 100
 *
 * Both closes are resolved **point-in-time** — the most recent bar at-or-before
 * the anchor date, mirroring eval/replay.ts. That makes the resolver naturally
 * holiday-aware: a holiday-short week (no Friday bar) walks back to the last
 * available close. `asOf` lets the provisional in-week scorer (FS-09) value the
 * week from the latest available close instead of Friday's; it defaults to the
 * week-end Friday for the settled Friday score.
 *
 * `price_bar.close` is BIGINT cents; the return is scale-invariant, so the cents
 * units cancel and `returnPct` is unit-free. The raw closes are surfaced (in
 * cents) for the breakdown explainer.
 */
import type { Pool, PoolClient } from 'pg';
import { currentFriday, nyseRegularCloseAnchor } from '../market/holidays.js';
import { mergedCloseSql } from './closes.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** A scoring week resolved to its two regular-close anchors (cents at-or-before). */
export interface WeekWindow {
  /** The week's Friday 16:00-ET close anchor (the "this" close). */
  weekEnd: Date;
  /** The prior Friday's 16:00-ET close anchor (the baseline). */
  baselineAt: Date;
}

/**
 * The last *fully completed* scoring weeks, most recent first. The current
 * (in-flight) week is excluded: week 0 ends on the Friday before `currentFriday`,
 * so this reads cleanly any weekday (the only soft edge is the few hours Friday
 * after settle, acceptable for the scouting columns). Both endpoints anchor at
 * the 16:00-ET regular close — the same anchor the Friday settle uses — so the
 * inventory's "points last week" matches the most recent scoringHistory entry.
 */
export function recentCompletedWeeks(now: Date, count: number): WeekWindow[] {
  const friday = currentFriday(now);
  const weeks: WeekWindow[] = [];
  for (let i = 1; i <= count; i++) {
    weeks.push({
      weekEnd: nyseRegularCloseAnchor(new Date(friday.getTime() - i * WEEK_MS)),
      baselineAt: nyseRegularCloseAnchor(
        new Date(friday.getTime() - (i + 1) * WEEK_MS),
      ),
    });
  }
  return weeks;
}

/** The single most-recently-completed scoring week's anchors. */
export function lastCompletedWeek(now: Date): WeekWindow {
  return recentCompletedWeeks(now, 1)[0]!;
}

/**
 * The in-flight (not-yet-settled) scoring week: `weekEnd` is this week's coming
 * Friday close, `baselineAt` the just-passed Friday's. Pair with `weeklyReturn`'s
 * `asOf = now` to value it "so far" off the latest available close.
 */
export function currentWeek(now: Date): WeekWindow {
  const friday = currentFriday(now);
  return {
    weekEnd: nyseRegularCloseAnchor(friday),
    baselineAt: nyseRegularCloseAnchor(new Date(friday.getTime() - WEEK_MS)),
  };
}

/** Percent move between two closes (cents); null when either is missing / baseline ≤ 0. */
export function returnPctFrom(
  lastClose: number | null,
  thisClose: number | null,
): number | null {
  if (lastClose == null || thisClose == null || lastClose <= 0) return null;
  return ((thisClose - lastClose) / lastClose) * 100;
}

export interface WeeklyReturn {
  /** Prior-Friday close (cents), or null if no bar resolves at-or-before it. */
  lastClose: number | null;
  /** This-Friday (or asOf) close (cents), or null if none resolves. */
  thisClose: number | null;
  /** Percent move, or null when either close is missing / baseline ≤ 0. */
  returnPct: number | null;
}

/**
 * The merged daily close (cents) for `symbol` at `at`: the official session_close
 * for the anchor's ET session, else the most recent price_bar at-or-before `at`,
 * else null. Precedence and the DATE↔ts mapping live in closes.ts.
 */
async function closeAtOrBefore(
  db: Pool | PoolClient,
  symbol: string,
  at: Date,
): Promise<number | null> {
  const { rows } = await db.query<{ close: string | number | null }>(
    `SELECT ${mergedCloseSql('$1', '$2')} AS close`,
    [symbol, at],
  );
  return rows[0]?.close != null ? Number(rows[0].close) : null;
}

/**
 * The week's percent return for `symbol`. `weekEnd` is the scoring week's Friday;
 * the baseline is the prior Friday — by default `weekEnd − 7d`, but the settle
 * passes an explicit `baselineAt` so the prior-week close is anchored zone-aware
 * (a fixed 7-day subtraction shifts an hour across a DST boundary and would value
 * the two endpoints at different points in the trading day). `asOf` (default
 * `weekEnd`) caps the "this" close for provisional in-week scoring. Returns null
 * `returnPct` when either close is unavailable so the scorer can credit 0.
 */
export async function weeklyReturn(
  db: Pool | PoolClient,
  symbol: string,
  weekEnd: Date,
  asOf: Date = weekEnd,
  baselineAt: Date = new Date(weekEnd.getTime() - WEEK_MS),
): Promise<WeeklyReturn> {
  const lastClose = await closeAtOrBefore(db, symbol, baselineAt);
  const thisClose = await closeAtOrBefore(db, symbol, asOf);
  // Stock price floors at 0, so a long return floors at −100% (a short's gain
  // caps at +100% / +1000 pts); a squeeze is unbounded above (the "pick-six").
  return {
    lastClose,
    thisClose,
    returnPct: returnPctFrom(lastClose, thisClose),
  };
}
