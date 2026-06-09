import type { Redis } from 'ioredis';
import type { PricesResponse } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { massiveGet } from '../massive/client.js';
import type { components } from '../massive/massive.gen.js';
import { insertBars } from './insertBars.js';
import { publishPricesUpdated } from '../events/publisher.js';
import { aggPath, MULTIPLIER, TIMESPAN, MAX_RESULTS } from './granularity.js';
import { jobLogger } from '../log/logger.js';
import { recordEodRun } from '../metrics/redis.js';

const baseLog = jobLogger('session-update');

type AggregatesResponse = components['schemas']['AggregatesResponse'];

const DAY_MS = 24 * 60 * 60 * 1000;
// Trailing window fetched each run. >1 lets a missed run (downtime, an extra
// holiday) self-heal on the next one; ON CONFLICT keeps re-fetches idempotent.
const SESSION_LOOKBACK_DAYS = parseInt(
  process.env['SESSION_LOOKBACK_DAYS'] ?? '4',
  10,
);

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  baseLog[level](extra ?? {}, msg);
}

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Appends the most recently closed session's bars (at the configured Massive
 * resolution) for every backfilled symbol, then publishes prices.updated with
 * the latest bar per symbol. Replaces the old Finnhub /quote EOD job — Finnhub
 * does not serve intraday candles on the free tier, and using Massive here keeps
 * the live tail at the same granularity as the historical store.
 *
 * Runs once after the close (see scheduler.ts). The free Massive feed is ~15-min
 * delayed, so a post-close run already sees the full final session.
 */
export async function runIntradayUpdate(redis: Redis): Promise<void> {
  const { rows } = await pool.query<{ symbol: string }>(
    // Mirror the playable corpus (loadUniverse): skip removed and depth-capped
    // ('incomplete') symbols so the session updater doesn't append fresh bars to
    // an excluded symbol's stale tail or waste fetches on it.
    `SELECT symbol FROM universe_symbol
      WHERE backfilled = true
        AND removed_at IS NULL
        AND data_status IS DISTINCT FROM 'incomplete'
      ORDER BY symbol`,
  );

  if (rows.length === 0) {
    log('info', 'no backfilled symbols — skipping');
    return;
  }

  const nowMs = Date.now();
  const from = toDateStr(nowMs - SESSION_LOOKBACK_DAYS * DAY_MS);
  const to = toDateStr(nowMs);

  log('info', 'starting session update', {
    symbols: rows.length,
    multiplier: MULTIPLIER,
    timespan: TIMESPAN,
    from,
    to,
  });

  const startedAt = Date.now();
  const asOf = new Date(nowMs).toISOString();
  const series: PricesResponse['series'] = {};
  let bars = 0;

  for (const { symbol } of rows) {
    const response = await massiveGet<AggregatesResponse>(
      redis,
      aggPath(symbol, from, to),
      // Match the backfill: pass the real cap so a busy session is never
      // truncated to the 5000-bar default (see granularity.ts MAX_RESULTS).
      { sort: 'asc', limit: MAX_RESULTS },
    );

    const results = response.results ?? [];
    if (results.length === 0) continue;

    await insertBars(symbol, results);
    bars += results.length;

    // Publish only the latest bar per symbol — enough for a ticker refresh and
    // keeps the WS payload small even with many intraday bars per session.
    const last = results.at(-1);
    if (last) {
      series[symbol] = [
        {
          ts: new Date(last.t).toISOString(),
          open: toCents(last.o),
          high: toCents(last.h),
          low: toCents(last.l),
          close: toCents(last.c),
          volume: last.v ?? null,
        },
      ];
    }
  }

  if (Object.keys(series).length > 0) {
    await publishPricesUpdated(redis, asOf, series);
  }

  // Stamp the run for /admin/ops + the alerter (item 10). This is the platform's
  // EOD-update health signal (snapshots/leaderboard were dropped in item 16).
  await recordEodRun(redis, Date.now() - startedAt, bars);

  log('info', 'session update complete', {
    symbolsUpdated: Object.keys(series).length,
    bars,
  });
}
