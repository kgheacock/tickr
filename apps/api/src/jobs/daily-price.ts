import type { Redis } from 'ioredis';
import type { QuotesResponse } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { finnhubGet } from '../finnhub/client.js';
import { publishQuotesUpdated } from '../events/publisher.js';

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
 * and the ON CONFLICT (symbol, ts) guard makes it a no-op.
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
  let inserted = 0;
  let skipped = 0;
  const quotes: QuotesResponse['quotes'] = {};

  for (const { symbol } of rows) {
    const quote = await finnhubGet<QuoteResponse>(redis, '/quote', { symbol });

    const closeCents = toCents(quote.c);
    const result = await pool.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (symbol, ts) DO NOTHING`,
      [
        symbol,
        ts,
        toCents(quote.o),
        toCents(quote.h),
        toCents(quote.l),
        closeCents,
      ],
    );

    if ((result.rowCount ?? 0) > 0) {
      inserted++;
      quotes[symbol] = { price: closeCents, ts };
    } else {
      skipped++;
    }
  }

  // Notify the WS gateway (item 09) with the freshly-updated symbols.
  if (Object.keys(quotes).length > 0) {
    await publishQuotesUpdated(redis, ts, quotes);
  }

  log('info', 'daily price update complete', { inserted, skipped });
}
