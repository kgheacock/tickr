#!/usr/bin/env tsx
/**
 * Probe — Massive ticker *reference* (metadata + branding) integration.
 *
 * Confirms whether the Massive REST surface exposes, for our universe symbols:
 *   1. Company metadata via GET /v3/reference/tickers/{ticker}
 *      (name, primary_exchange, type, market_cap, sic_code/description, etc.).
 *   2. Branding image URLs (branding.logo_url / branding.icon_url) and whether
 *      those images are actually fetchable with the same Bearer key.
 *   3. How multi-class tickers stored with a dash (BRK-B, MOG-A) must be
 *      reformatted (Massive/Polygon uses a dot: BRK.B).
 *
 * Usage:
 *   MASSIVE_API_KEY=xxx tsx scripts/probe-massive-reference.ts
 */

const KEY = process.env['MASSIVE_API_KEY'];
if (!KEY) {
  console.error('MASSIVE_API_KEY is not set. Set it and re-run.');
  process.exit(1);
}

const BASE = 'https://api.massive.com';
const AUTH = { Authorization: `Bearer ${KEY}` } as const;

// Massive free tier: 5 req/min on a fixed-minute window (docs T2c). Image
// fetches count against the same budget, so every outbound call — details and
// branding images alike — is spaced through one limiter at 15s (≤4/clock-min).
const SPACING_MS = 15_000;
let nextSlot = 0;
async function throttle(): Promise<void> {
  const wait = nextSlot - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextSlot = Date.now() + SPACING_MS;
}

// A focused spread: a clean baseline, both Alphabet share classes, and the two
// dash-format symbols the data audit flagged as NO_BARS (do they resolve under
// the dotted form Massive expects?).
const SAMPLE = ['AAPL', 'GOOGL', 'GOOG', 'BRK-B', 'MOG-A'];

interface Branding {
  logo_url?: string;
  icon_url?: string;
}
interface TickerDetails {
  ticker: string;
  name?: string;
  primary_exchange?: string;
  type?: string;
  market_cap?: number;
  sic_code?: string;
  sic_description?: string;
  homepage_url?: string;
  list_date?: string;
  total_employees?: number;
  branding?: Branding;
}
interface DetailsResponse {
  results?: TickerDetails;
  status?: string;
}

// Massive/Polygon represent share classes with a dot, but our universe stores a
// dash. Try the symbol as-is, then fall back to the dotted form on a 404.
function candidates(symbol: string): string[] {
  if (symbol.includes('-')) return [symbol, symbol.replace('-', '.')];
  return [symbol];
}

// Throttled GET with a single 429 backoff. On 429 we wait out the rest of the
// fixed-minute window (the cap is per clock-minute) and retry once.
async function get(url: string): Promise<Response> {
  await throttle();
  let res = await fetch(url, {
    headers: AUTH,
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 429) {
    console.log('   (429 — backing off 60s for the next window…)');
    await new Promise((r) => setTimeout(r, 60_000));
    await throttle();
    res = await fetch(url, {
      headers: AUTH,
      signal: AbortSignal.timeout(15_000),
    });
  }
  return res;
}

async function fetchDetails(
  symbol: string,
): Promise<{ used: string; status: number; data?: TickerDetails }> {
  let lastStatus = 0;
  for (const cand of candidates(symbol)) {
    const res = await get(`${BASE}/v3/reference/tickers/${cand}`);
    lastStatus = res.status;
    if (res.ok) {
      const body = (await res.json()) as DetailsResponse;
      return { used: cand, status: res.status, data: body.results };
    }
  }
  return { used: symbol, status: lastStatus };
}

async function imageOk(url: string | undefined): Promise<string> {
  if (!url) return 'none';
  const res = await get(url);
  const type = res.headers.get('content-type') ?? '?';
  const len = res.headers.get('content-length') ?? '?';
  return `HTTP ${res.status} ${type} ${len}B`;
}

function fmtCap(n: number | undefined): string {
  if (n == null) return '—';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  return `$${(n / 1e6).toFixed(0)}M`;
}

async function main(): Promise<void> {
  let withMeta = 0;
  let withLogo = 0;
  let withIcon = 0;

  for (const symbol of SAMPLE) {
    const { used, status, data } = await fetchDetails(symbol);
    if (!data) {
      console.log(`\n${symbol}  ✗ no metadata (HTTP ${status})`);
      continue;
    }
    withMeta++;
    const fields = [
      `name=${data.name ?? '—'}`,
      `exch=${data.primary_exchange ?? '—'}`,
      `type=${data.type ?? '—'}`,
      `cap=${fmtCap(data.market_cap)}`,
      `sic=${data.sic_code ?? '—'}(${data.sic_description ?? '—'})`,
      `listed=${data.list_date ?? '—'}`,
      `employees=${data.total_employees ?? '—'}`,
      `home=${data.homepage_url ?? '—'}`,
    ];
    const logo = data.branding?.logo_url;
    const icon = data.branding?.icon_url;
    if (logo) withLogo++;
    if (icon) withIcon++;
    // Fetch only the logo image (budget is tight); icon presence is reported
    // from the metadata payload without a second image request.
    const logoCheck = await imageOk(logo);

    console.log(
      `\n${symbol}${used !== symbol ? ` (as ${used})` : ''}  ✓ HTTP ${status}`,
    );
    for (const f of fields) console.log(`   ${f}`);
    console.log(`   logo_url: ${logo ?? '—'}`);
    console.log(`     ↳ image fetch: ${logoCheck}`);
    console.log(`   icon_url: ${icon ?? '—'}`);
  }

  console.log(
    `\n── summary ──\n` +
      `  metadata: ${withMeta}/${SAMPLE.length}\n` +
      `  logo_url: ${withLogo}/${SAMPLE.length}\n` +
      `  icon_url: ${withIcon}/${SAMPLE.length}`,
  );
}

main().catch((err: unknown) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
