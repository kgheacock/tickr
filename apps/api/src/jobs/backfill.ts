import type { Redis } from 'ioredis';
import pLimit from 'p-limit';
import { pool } from '../db/pool.js';
import { massiveGet } from '../massive/client.js';
import type { components } from '../massive/massive.gen.js';
import { insertBars } from './insertBars.js';

type AggregatesResponse = components['schemas']['AggregatesResponse'];

const CONCURRENCY = parseInt(process.env['BACKFILL_CONCURRENCY'] ?? '4', 10);
const WINDOW_DAYS = parseInt(process.env['BACKFILL_WINDOW_DAYS'] ?? '365', 10);
const LOOKBACK_DAYS = parseInt(
  process.env['BACKFILL_LOOKBACK_DAYS'] ?? '730',
  10,
);
const BACKFILL_START_DATE = process.env['BACKFILL_START_DATE'];

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  console[level](
    JSON.stringify({ level, component: 'backfill', msg, ...extra }),
  );
}

function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function backfillSymbol(redis: Redis, symbol: string): Promise<void> {
  const nowMs = Date.now();
  const startMs = BACKFILL_START_DATE
    ? new Date(BACKFILL_START_DATE).getTime()
    : nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;

  log('info', 'symbol start', { symbol });

  let fromMs = startMs;
  while (fromMs < nowMs) {
    const toMs = Math.min(fromMs + windowMs, nowMs);
    const from = toDateStr(fromMs);
    const to = toDateStr(toMs);

    const response = await massiveGet<AggregatesResponse>(
      redis,
      `/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}`,
      { sort: 'asc' },
    );

    const results = response.results ?? [];
    if (results.length > 0) {
      await insertBars(symbol, results);
      log('info', 'window inserted', {
        symbol,
        from,
        to,
        bars: results.length,
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
