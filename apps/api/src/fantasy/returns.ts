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

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyReturn {
  /** Prior-Friday close (cents), or null if no bar resolves at-or-before it. */
  lastClose: number | null;
  /** This-Friday (or asOf) close (cents), or null if none resolves. */
  thisClose: number | null;
  /** Percent move, or null when either close is missing / baseline ≤ 0. */
  returnPct: number | null;
}

/** Most recent close (cents) at-or-before `at`, or null if no such bar. */
async function closeAtOrBefore(
  db: Pool | PoolClient,
  symbol: string,
  at: Date,
): Promise<number | null> {
  const { rows } = await db.query<{ close: string | number }>(
    `SELECT close
       FROM price_bar
      WHERE symbol = $1 AND ts <= $2
      ORDER BY ts DESC
      LIMIT 1`,
    [symbol, at],
  );
  return rows[0] ? Number(rows[0].close) : null;
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
  if (lastClose == null || thisClose == null || lastClose <= 0) {
    return { lastClose, thisClose, returnPct: null };
  }
  // Stock price floors at 0, so a long return floors at −100% (a short's gain
  // caps at +100% / +1000 pts); a squeeze is unbounded above (the "pick-six").
  const returnPct = ((thisClose - lastClose) / lastClose) * 100;
  return { lastClose, thisClose, returnPct };
}
