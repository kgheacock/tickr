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

// Per-request `limit` for the aggregates API. The free Massive tier caps each
// response well below the documented 50000 max (~4.1k bars at 15-min) and
// returns a `next_url` for the remainder, so this is an upper bound, not the
// page size. The backfill follows next_url (massiveGetPaged) to fetch the full
// range across pages, so a window no longer has to be sized under the cap —
// passing the documented max just maximises bars per page (fewer requests).
export const MAX_RESULTS = 50_000;
