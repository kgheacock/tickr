// Shared price-bar granularity for the Massive aggregates API, used by both the
// historical backfill and the per-session updater so they always agree on
// resolution. Defaults to 15-minute bars.
//
// The free Massive tier serves minute/hour aggregates for the trailing ~2 years
// (the same depth as daily), so finer resolutions cost more bars per request but
// no extra money — see docs/10-populating-the-database.md.

export const MULTIPLIER = parseInt(
  process.env['BACKFILL_MULTIPLIER'] ?? '15',
  10,
);
export const TIMESPAN = process.env['BACKFILL_TIMESPAN'] ?? 'minute';

/** Massive/Polygon aggregates path at the configured resolution. */
export function aggPath(symbol: string, from: string, to: string): string {
  return `/v2/aggs/ticker/${symbol}/range/${MULTIPLIER}/${TIMESPAN}/${from}/${to}`;
}

// Upper bound of bars per trading day for the configured resolution, using the
// ~16h extended session (04:00–20:00 ET). Used to size request windows so a
// single call stays under the provider's 50k-result cap (the client does not
// paginate, so an over-large window would silently truncate and leave gaps).
const EXT_SESSION_MINUTES = 16 * 60;
export function estBarsPerDay(): number {
  switch (TIMESPAN) {
    case 'second':
      return (EXT_SESSION_MINUTES * 60) / MULTIPLIER;
    case 'minute':
      return EXT_SESSION_MINUTES / MULTIPLIER;
    case 'hour':
      return 16 / MULTIPLIER;
    default:
      return 1; // day / week / month / quarter / year
  }
}

const RESULT_CAP = 50_000;
const SAFE_FILL = 0.9; // headroom under the hard cap

/**
 * Clamp a requested window (in days) so one aggregates request can't exceed the
 * 50k-result cap at the configured resolution. Treating every calendar day as a
 * trading day overcounts (only ~5/7 trade), which only makes the window safer.
 * Coarse resolutions (hour/day) are unaffected; fine ones auto-shrink.
 */
export function safeWindowDays(requestedDays: number): number {
  const perDay = Math.max(1, estBarsPerDay());
  const maxDays = Math.max(1, Math.floor((RESULT_CAP * SAFE_FILL) / perDay));
  return Math.min(requestedDays, maxDays);
}
