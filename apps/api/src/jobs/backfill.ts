// T2b resolved 2026-05-31: /stock/candle is premium-only on the Finnhub free tier
// (403 for all resolutions). This job is correct but will fail until the plan is
// upgraded or an alternative source is chosen. See docs/09-open-questions.md T2b.
import type { Redis } from 'ioredis';
import pLimit from 'p-limit';
import { pool } from '../db/pool.js';
import { finnhubGet } from '../finnhub/client.js';

const CONCURRENCY = parseInt(process.env['FINNHUB_CONCURRENCY'] ?? '4', 10);

// Window per /stock/candle call. Daily bars are small; 365 days per call is safe.
const WINDOW_DAYS = parseInt(process.env['BACKFILL_WINDOW_DAYS'] ?? '365', 10);
const LOOKBACK_DAYS = parseInt(
  process.env['BACKFILL_LOOKBACK_DAYS'] ?? String(5 * 365),
  10,
);

interface CandleResponse {
  s: 'ok' | 'no_data';
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
}

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  console[level](
    JSON.stringify({ level, component: 'backfill', msg, ...extra }),
  );
}

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

async function insertBars(
  symbol: string,
  candles: CandleResponse,
): Promise<void> {
  const ts = candles.t!;
  const opens = candles.o!;
  const highs = candles.h!;
  const lows = candles.l!;
  const closes = candles.c!;
  const vols = candles.v!;

  // Use unnest to pass all rows as parallel arrays — avoids the 65,535
  // bind-parameter limit that chunked multi-row VALUES would hit.
  await pool.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
     SELECT
       unnest($1::text[])          AS symbol,
       unnest($2::timestamptz[])   AS ts,
       unnest($3::bigint[])        AS open,
       unnest($4::bigint[])        AS high,
       unnest($5::bigint[])        AS low,
       unnest($6::bigint[])        AS close,
       unnest($7::numeric[])       AS volume
     ON CONFLICT (symbol, ts) DO NOTHING`,
    [
      ts.map(() => symbol),
      ts.map((t) => new Date(t * 1000).toISOString()),
      opens.map(toCents),
      highs.map(toCents),
      lows.map(toCents),
      closes.map(toCents),
      vols.map((v) => v ?? null),
    ],
  );
}

async function backfillSymbol(redis: Redis, symbol: string): Promise<void> {
  const nowMs = Date.now();
  const startMs = nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;

  log('info', 'symbol start', { symbol });

  let fromMs = startMs;
  while (fromMs < nowMs) {
    const toMs = Math.min(fromMs + windowMs, nowMs);
    const from = Math.floor(fromMs / 1000);
    const to = Math.floor(toMs / 1000);

    const candles = await finnhubGet<CandleResponse>(redis, '/stock/candle', {
      symbol,
      resolution: 5,
      from,
      to,
    });

    if (candles.s === 'ok' && (candles.t?.length ?? 0) > 0) {
      await insertBars(symbol, candles);
      log('info', 'window inserted', {
        symbol,
        from,
        to,
        bars: candles.t!.length,
      });
    } else {
      log('info', 'window no_data', { symbol, from, to });
    }

    fromMs = toMs;
  }

  await pool.query(
    `UPDATE universe_symbol SET backfilled = true, backfilled_at = now() WHERE symbol = $1`,
    [symbol],
  );
  log('info', 'symbol done', { symbol });
}

export async function runBackfill(redis: Redis): Promise<void> {
  const limit = pLimit(CONCURRENCY);

  const { rows } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol WHERE backfilled = false ORDER BY symbol`,
  );

  if (rows.length === 0) {
    log('info', 'nothing to backfill');
    return;
  }

  log('info', 'starting backfill', {
    total: rows.length,
    windowDays: WINDOW_DAYS,
    lookbackDays: LOOKBACK_DAYS,
  });

  await Promise.all(
    rows.map((row) => limit(() => backfillSymbol(redis, row.symbol))),
  );

  log('info', 'backfill complete', { total: rows.length });
}
