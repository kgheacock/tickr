#!/usr/bin/env tsx
/**
 * Probe — does Massive expose an endpoint that returns the *current S&P 500
 * constituents* (so we can drop the hardcoded data/sp500.csv universe)?
 *
 * Massive mirrors Polygon's REST surface. Polygon proper has no public
 * "index constituents" endpoint, but Massive may differ — so we probe a spread
 * of plausible paths and report status + a body snippet for each.
 *
 * Usage: MASSIVE_API_KEY=xxx tsx scripts/probe-massive-constituents.ts
 */

const KEY = process.env['MASSIVE_API_KEY'];
if (!KEY) {
  console.error('MASSIVE_API_KEY is not set.');
  process.exit(1);
}

const BASE = 'https://api.massive.com';
const AUTH = { Authorization: `Bearer ${KEY}` } as const;

// Free tier ≈5 req/min on a fixed-minute window. Space calls ~14s apart.
const SPACING_MS = 14_000;
let nextSlot = 0;
async function throttle(): Promise<void> {
  const wait = nextSlot - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextSlot = Date.now() + SPACING_MS;
}

async function get(path: string): Promise<void> {
  await throttle();
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  let status = 0;
  let snippet = '';
  try {
    const res = await fetch(url, {
      headers: AUTH,
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    const text = await res.text();
    snippet = text.slice(0, 600).replace(/\s+/g, ' ');
  } catch (err) {
    snippet = `FETCH ERROR: ${err instanceof Error ? err.message : String(err)}`;
  }
  const mark = status >= 200 && status < 300 ? '✓' : '✗';
  console.log(`\n${mark} HTTP ${status}  ${path}`);
  console.log(`   ${snippet}`);
}

// Candidate paths: known-good baselines first, then index/constituent guesses.
const CANDIDATES = [
  // Baselines — confirm reference surface + auth work at all.
  '/v3/reference/tickers?market=stocks&type=CS&active=true&limit=1',
  '/v3/reference/tickers/I:SPX',
  '/v3/reference/tickers/SPX',
  // Index snapshot (Polygon indices product).
  '/v3/snapshot/indices?ticker.any_of=I:SPX',
  // Direct constituent guesses (Massive extensions / common conventions).
  '/v3/reference/indices/I:SPX/constituents',
  '/v3/reference/indices/SPX/constituents',
  '/v3/reference/index/I:SPX/constituents',
  '/v3/reference/constituents/SPX',
  '/v1/indices/constituents?index=SPX',
  '/v3/reference/tickers?market=indices&search=S%26P%20500&limit=5',
  // Related-companies (Polygon) — not constituents but adjacent.
  '/v1/related-companies/AAPL',
  '/v3/reference/related-companies/AAPL',
];

async function main(): Promise<void> {
  console.log(
    `Probing ${CANDIDATES.length} endpoints (~${Math.ceil((CANDIDATES.length * SPACING_MS) / 1000)}s)…`,
  );
  for (const path of CANDIDATES) await get(path);
  console.log('\n── done ──');
}

main().catch((err: unknown) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
