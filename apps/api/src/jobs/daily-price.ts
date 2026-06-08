import type { Redis } from 'ioredis';
import type { PricesResponse } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { finnhubGet } from '../finnhub/client.js';
import { publishPricesUpdated } from '../events/publisher.js';

interface QuoteResponse {
  c: number; // current price (used as close; v1 approximation per O5)
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close (not stored)
}

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  console[level](
    JSON.stringify({ level, component: 'daily-price', msg, ...extra }),
  );
}

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * Returns today's market-close timestamp at 21:00 UTC (≈16:00 ET standard).
 * Deterministic for the calendar day so a second run produces the same ts
 * and the upsert refreshes the same row.
 */
export function marketCloseTs(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      21,
      0,
      0,
      0,
    ),
  );
}

export async function runDailyPrice(redis: Redis): Promise<void> {
  const { rows } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol WHERE backfilled = true ORDER BY symbol`,
  );

  if (rows.length === 0) {
    log('info', 'no backfilled symbols — skipping');
    return;
  }

  log('info', 'starting daily price update', { symbols: rows.length });

  const ts = marketCloseTs().toISOString();
  let written = 0;
  const series: PricesResponse['series'] = {};

  for (const { symbol } of rows) {
    const quote = await finnhubGet<QuoteResponse>(redis, '/quote', { symbol });

    const open = toCents(quote.o);
    const high = toCents(quote.h);
    const low = toCents(quote.l);
    const close = toCents(quote.c);

    // Best-available precedence (D4): Finnhub provides the current/most-recent
    // day, so on conflict it WINS over any historical (Massive) bar for the
    // same (symbol, ts). Backfill (insertBars.ts) uses DO NOTHING so it never
    // clobbers a Finnhub bar.
    await pool.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (symbol, ts) DO UPDATE SET
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close`,
      [symbol, ts, open, high, low, close],
    );

    written++;
    series[symbol] = [{ ts, open, high, low, close, volume: null }];
  }

  // Notify the WS gateway (prices topic) with the freshly-written bars.
  if (Object.keys(series).length > 0) {
    await publishPricesUpdated(redis, ts, series);
  }

  log('info', 'daily price update complete', { written });
}
