#!/usr/bin/env tsx
/**
 * T2c probe — empirically determines the Massive free-tier limits:
 *   1. Whether the endpoint is accessible on the current API key / tier.
 *   2. Available history depth (expected: 2 years of daily bars).
 *   3. Whether responses paginate via next_url.
 *   4. Actual rate limit (req/min or req/day) — set MASSIVE_RPS_LIMIT default.
 *
 * Usage:
 *   MASSIVE_API_KEY=xxx tsx scripts/probe-massive-candles.ts
 *
 * Pin findings in docs/09-open-questions.md (T2c row) before continuing.
 */

const KEY = process.env['MASSIVE_API_KEY'];
if (!KEY) {
  console.error('MASSIVE_API_KEY is not set. Set it and re-run.');
  process.exit(1);
}

const BASE = 'https://api.massive.com';

interface AggregatesResponse {
  status: string;
  resultsCount: number;
  results: Array<{
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }>;
  next_url?: string;
}

async function probe(
  symbol: string,
  fromDate: Date,
  toDate: Date,
): Promise<void> {
  const from = fromDate.toISOString().slice(0, 10);
  const to = toDate.toISOString().slice(0, 10);
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?sort=asc&limit=5000`;
  const label = `${from} → ${to}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });

  if (res.status === 429) {
    console.log(`[${label}] HTTP 429 — rate limited; slow down`);
    return;
  }
  if (res.status === 401 || res.status === 403) {
    console.log(`[${label}] HTTP ${res.status} — check API key / plan tier`);
    return;
  }
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status}`);
    return;
  }

  const data = (await res.json()) as AggregatesResponse;
  const count = data.results?.length ?? 0;
  const first =
    count > 0 ? new Date(data.results[0]!.t).toISOString().slice(0, 10) : '?';
  const last =
    count > 0
      ? new Date(data.results[count - 1]!.t).toISOString().slice(0, 10)
      : '?';
  const paginated = data.next_url ? 'YES next_url present' : 'no pagination';
  console.log(
    `[${label}] status=${data.status}  bars=${count}  first=${first}  last=${last}  pagination=${paginated}`,
  );
}

async function probeRateLimit(symbol: string): Promise<void> {
  console.log(
    '\nRate limit probe: sending 10 rapid requests and checking for 429...',
  );
  const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const url = `${BASE}/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}?sort=asc`;

  let hit429 = false;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    console.log(`  req ${i + 1}: HTTP ${res.status}`);
    if (res.status === 429) {
      hit429 = true;
      console.log(
        `  → 429 hit at request ${i + 1} — rate limit is likely ${i} req/min or less`,
      );
      break;
    }
  }
  if (!hit429) {
    console.log(
      '  → No 429 in 10 rapid requests — rate limit is > 10 req/min (or req/day based)',
    );
  }
}

async function main() {
  const now = new Date();
  const SYMBOL = 'AAPL';

  console.log(`Probing Massive Custom Bars endpoint for ${SYMBOL}\n`);

  const windows: Array<[number, string]> = [
    [90, '3 months'],
    [365, '1 year'],
    [730, '2 years'],
    [1095, '3 years'],
  ];

  for (const [days, label] of windows) {
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    process.stdout.write(`Probing ${label}... `);
    await probe(SYMBOL, from, now);
    await new Promise((r) => setTimeout(r, 2_000)); // conservative delay between probes
  }

  await probeRateLimit(SYMBOL);

  console.log('\nPin these results in docs/09-open-questions.md (T2c row).');
  console.log(
    'Set MASSIVE_RPS_LIMIT in .env to the measured requests-per-minute limit.',
  );
  console.log(
    'Set BACKFILL_LOOKBACK_DAYS to match the maximum available history depth.',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
