import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { pool } from '../db/pool.js';
import { jobLogger } from '../log/logger.js';
import { getEodLastRun, massive429Count } from '../metrics/redis.js';

/**
 * Worker alert tick (item 10). Runs every 5 minutes (see scheduler.ts) and
 * checks for stuck states:
 *   - EOD price-update lag > 26h (a daily run was missed).
 *   - backfill_remaining > 0 and unchanged for 1h (ingestion wedged).
 *   - Massive 429s in the last 5 min (token bucket mistuned).
 *
 * Each alert fires **once per stuck-state window**: a Redis flag is set when
 * it fires and cleared when the condition resolves, so a sustained problem
 * does not alert on every tick. Posts to `ALERT_WEBHOOK_URL` (Discord) when
 * set; otherwise logs at `warn`.
 */

const EOD_LAG_LIMIT_SEC = 26 * 60 * 60; // 26h
const BACKFILL_STUCK_MS = 60 * 60 * 1000; // 1h
const FIVE_MIN_MS = 5 * 60 * 1000;

const FLAG_PREFIX = 'alert:fired:';
const BACKFILL_STATE_KEY = 'alert:backfill:state';

export interface AlertDeps {
  now?: () => number;
  backfillRemaining?: () => Promise<number>;
  webhookUrl?: string | undefined;
  log?: Logger;
}

async function backfillRemainingFromDb(): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM universe_symbol WHERE backfilled = false`,
  );
  return rows[0]?.count ?? 0;
}

async function sendAlert(
  key: string,
  message: string,
  log: Logger,
  webhookUrl: string | undefined,
): Promise<void> {
  if (webhookUrl) {
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `🚨 tickr: ${message}` }),
      });
      log.info({ alert: key }, 'alert sent to webhook');
      return;
    } catch (err) {
      log.error(
        { alert: key, err: err instanceof Error ? err.message : String(err) },
        'alert webhook failed — falling back to log',
      );
    }
  }
  log.warn({ alert: key }, message);
}

/** Fire `key` only if it is not already in the fired state. Returns whether it fired. */
async function fireOnce(
  redis: Redis,
  key: string,
  message: string,
  log: Logger,
  webhookUrl: string | undefined,
): Promise<boolean> {
  const flag = `${FLAG_PREFIX}${key}`;
  const alreadyFired = await redis.set(flag, '1', 'NX');
  if (alreadyFired !== 'OK') return false; // flag already set this window
  await sendAlert(key, message, log, webhookUrl);
  return true;
}

async function clearFlag(redis: Redis, key: string): Promise<void> {
  await redis.del(`${FLAG_PREFIX}${key}`);
}

/**
 * Run one alert check. Returns the keys that fired this tick (for tests).
 */
export async function runAlertCheck(
  redis: Redis,
  deps: AlertDeps = {},
): Promise<string[]> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const log = deps.log ?? jobLogger('alerts');
  const webhookUrl = deps.webhookUrl ?? process.env['ALERT_WEBHOOK_URL'];
  const backfillRemaining = deps.backfillRemaining ?? backfillRemainingFromDb;
  const fired: string[] = [];

  // 1. EOD update lag.
  const lastRun = await getEodLastRun(redis);
  const lagSec = lastRun === null ? null : (nowMs - Date.parse(lastRun)) / 1000;
  if (lagSec !== null && lagSec > EOD_LAG_LIMIT_SEC) {
    const msg = `EOD price-update lag ${Math.round(lagSec / 3600)}h (> 26h)`;
    if (await fireOnce(redis, 'eod-lag', msg, log, webhookUrl))
      fired.push('eod-lag');
  } else {
    await clearFlag(redis, 'eod-lag');
  }

  // 2. Backfill stuck: remaining > 0 and unchanged for >= 1h.
  const remaining = await backfillRemaining();
  if (remaining <= 0) {
    await redis.del(BACKFILL_STATE_KEY);
    await clearFlag(redis, 'backfill-stuck');
  } else {
    const prev = await redis.get(BACKFILL_STATE_KEY);
    const parsed = prev
      ? (JSON.parse(prev) as { value: number; since: number })
      : null;
    if (!parsed || parsed.value !== remaining) {
      // Progress (or first observation) — reset the timer and the fired flag.
      await redis.set(
        BACKFILL_STATE_KEY,
        JSON.stringify({ value: remaining, since: nowMs }),
      );
      await clearFlag(redis, 'backfill-stuck');
    } else if (nowMs - parsed.since >= BACKFILL_STUCK_MS) {
      const msg = `backfill stuck: ${remaining} symbol(s) unchanged for >1h`;
      if (await fireOnce(redis, 'backfill-stuck', msg, log, webhookUrl))
        fired.push('backfill-stuck');
    }
  }

  // 3. Massive 429s in the last 5 minutes.
  const recent429 = await massive429Count(redis, FIVE_MIN_MS, nowMs);
  if (recent429 > 0) {
    const msg = `Massive returned ${recent429} 429(s) in the last 5 min`;
    if (await fireOnce(redis, 'massive-429', msg, log, webhookUrl))
      fired.push('massive-429');
  } else {
    await clearFlag(redis, 'massive-429');
  }

  return fired;
}
