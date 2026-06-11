#!/usr/bin/env tsx
/**
 * Probe — can /v3/reference/tickers sort by market cap, and does the list
 * response even carry market_cap? (It isn't in the default projection.)
 */
const KEY = process.env['MASSIVE_API_KEY'];
if (!KEY) {
  console.error('MASSIVE_API_KEY not set');
  process.exit(1);
}
const BASE = 'https://api.massive.com';
const AUTH = { Authorization: `Bearer ${KEY}` } as const;

const SPACING_MS = 14_000;
let nextSlot = 0;
async function throttle(): Promise<void> {
  const wait = nextSlot - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextSlot = Date.now() + SPACING_MS;
}
async function get(path: string): Promise<void> {
  await throttle();
  let status = 0,
    snippet = '';
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: AUTH,
      signal: AbortSignal.timeout(15_000),
    });
    status = res.status;
    snippet = (await res.text()).slice(0, 700).replace(/\s+/g, ' ');
  } catch (e) {
    snippet = `ERR ${e instanceof Error ? e.message : String(e)}`;
  }
  const mark = status >= 200 && status < 300 ? '✓' : '✗';
  console.log(`\n${mark} HTTP ${status}  ${path}\n   ${snippet}`);
}

const CANDIDATES = [
  // Does sort=market_cap work, and what comes back first?
  '/v3/reference/tickers?market=stocks&type=CS&active=true&sort=market_cap&order=desc&limit=3',
  // Does the list projection include market_cap at all (default sort)?
  '/v3/reference/tickers?market=stocks&type=CS&active=true&limit=3',
  // An invalid sort field surfaces what the API considers sortable.
  '/v3/reference/tickers?market=stocks&type=CS&active=true&sort=bogus_field&limit=3',
];
async function main() {
  for (const p of CANDIDATES) await get(p);
  console.log('\n── done ──');
}
main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
