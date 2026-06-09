/**
 * ETF handle detection and normalization.
 *
 * ETF handles are prefixed with "etf:" (e.g. "etf:big7"). Real symbol handles
 * are uppercased (e.g. "AAPL"). This module provides the canonical
 * normalization so that both /prices and /evaluate apply the same rules.
 */

const ETF_PREFIX = 'etf:';

/** True iff the already-normalized handle refers to an ETF (not a real symbol). */
export function isEtfHandle(handle: string): boolean {
  return handle.startsWith(ETF_PREFIX);
}

/**
 * Normalize a raw symbol string. ETF handles become lowercase-keyed (e.g.
 * "ETF:BIG7" → "etf:big7"). Everything else is uppercased (e.g. "aapl" →
 * "AAPL"). This is the single normalization point — callers must not uppercase
 * after calling this.
 */
export function normalizeHandle(raw: string): string {
  if (raw.toLowerCase().startsWith(ETF_PREFIX)) {
    return ETF_PREFIX + raw.slice(ETF_PREFIX.length).toLowerCase();
  }
  return raw.toUpperCase();
}

/** Extract the ETF key from a normalized ETF handle ("etf:big7" → "big7"). */
export function etfKey(handle: string): string {
  return handle.slice(ETF_PREFIX.length);
}
