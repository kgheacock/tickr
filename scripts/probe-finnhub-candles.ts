#!/usr/bin/env tsx
/**
 * T2b probe — empirically determines the Finnhub /stock/candle free-tier limits:
 *   1. Whether the endpoint is accessible on the current API key / tier.
 *   2. The per-call window size (how far back data is available).
 *   3. Whether /stock/candle returns all bars in one call or truncates.
 *
 * Usage:
 *   FINNHUB_API_KEY=xxx tsx scripts/probe-finnhub-candles.ts
 *
 * Pin findings in docs/09-open-questions.md (T2b row) before running backfill.
 */

const KEY = process.env['FINNHUB_API_KEY'];
if (!KEY) {
  console.error('FINNHUB_API_KEY is not set. Set it and re-run.');
  process.exit(1);
}

const BASE = 'https://finnhub.io/api/v1';

interface CandleResponse {
  s: 'ok' | 'no_data';
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
}

async function probe(
  symbol: string,
  fromDate: Date,
  toDate: Date,
): Promise<void> {
  const from = Math.floor(fromDate.getTime() / 1000);
  const to = Math.floor(toDate.getTime() / 1000);
  const url = `${BASE}/stock/candle?symbol=${symbol}&resolution=5&from=${from}&to=${to}&token=${KEY}`;

  const label = `${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`;
  const res = await fetch(url);

  if (res.status === 403) {
    console.log(`[${label}] HTTP 403 — endpoint blocked on this tier`);
    return;
  }
  if (res.status === 429) {
    console.log(`[${label}] HTTP 429 — rate limited; slow down`);
    return;
  }
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status}`);
    return;
  }

  const data = (await res.json()) as CandleResponse;
  if (data.s === 'no_data') {
    console.log(`[${label}] s=no_data — no bars in this range`);
    return;
  }
  const count = data.t?.length ?? 0;
  const first = data.t
    ? new Date(data.t[0]! * 1000).toISOString().slice(0, 10)
    : '?';
  const last = data.t
    ? new Date(data.t[data.t.length - 1]! * 1000).toISOString().slice(0, 10)
    : '?';
  console.log(`[${label}] s=ok  bars=${count}  first=${first}  last=${last}`);
}

async function main() {
  const now = new Date();
  const SYMBOL = 'AAPL';

  console.log(`Probing Finnhub /stock/candle?resolution=5 for ${SYMBOL}\n`);

  const windows: Array<[number, string]> = [
    [90, '3 months'],
    [180, '6 months'],
    [365, '1 year'],
    [730, '2 years'],
    [1095, '3 years'],
    [1825, '5 years'],
  ];

  for (const [days, label] of windows) {
    const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    process.stdout.write(`Probing ${label}... `);
    await probe(SYMBOL, from, now);
    await new Promise((r) => setTimeout(r, 1100)); // stay under 60 req/min
  }

  console.log('\nPin these results in docs/09-open-questions.md (T2b row).');
  console.log(
    'Set BACKFILL_WINDOW_DAYS in .env to the maximum window that returns data.',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
