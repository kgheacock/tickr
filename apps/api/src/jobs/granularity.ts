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

/**
 * Translate our canonical ticker to the form the Massive/Polygon aggregates API
 * expects. We store share-class suffixes with a hyphen (the S&P/CSV convention,
 * e.g. `BRK-B`, `MOG-A`) but Polygon uses a period (`BRK.B`, `MOG.A`). Building
 * the URL literally returns 0 results, so the symbol gets marked backfilled with
 * no bars (data audit Finding 4). We translate only at the request boundary so
 * the hyphen stays canonical everywhere else (DB rows, FKs, API responses).
 */
export function toMassiveTicker(symbol: string): string {
  return symbol.replace('-', '.');
}

/** Massive/Polygon aggregates path at the configured resolution. */
export function aggPath(symbol: string, from: string, to: string): string {
  return `/v2/aggs/ticker/${toMassiveTicker(symbol)}/range/${MULTIPLIER}/${TIMESPAN}/${from}/${to}`;
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

// Effective per-response bar cap on the free Massive tier. The `limit` query
// param is documented as max 50000, but the free tier ignores it and caps each
// response at ~4.1k bars, returning a `next_url` for the rest (verified
// empirically: a 730-day 15-min AAPL request pages at ~4165 bars/page). The
// client does NOT follow next_url, so any window that would exceed one page is
// silently truncated — the true cause of the audit's near-zero-coverage gaps.
// We size windows under this real cap instead of paginating (matching the
// existing design); raise it / add next_url pagination if the tier changes.
export const MAX_RESULTS = 4_000;
const SAFE_FILL = 0.9; // headroom under the per-page cap

/**
 * Clamp a requested window (in days) so one aggregates request stays within a
 * single response page at the configured resolution (no next_url, no silent
 * truncation). Treating every calendar day as a trading day overcounts (only
 * ~5/7 trade), which only makes the window safer. Coarse resolutions (hour/day)
 * are unaffected; fine ones auto-shrink (15-min → ~56-day windows).
 */
export function safeWindowDays(requestedDays: number): number {
  const perDay = Math.max(1, estBarsPerDay());
  const maxDays = Math.max(1, Math.floor((MAX_RESULTS * SAFE_FILL) / perDay));
  return Math.min(requestedDays, maxDays);
}
