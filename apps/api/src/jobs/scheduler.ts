import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runIntradayUpdate } from './intraday-update.js';
import { tryAcquireLock, releaseLock } from './locks.js';
import { isNyseHoliday } from '../market/holidays.js';
import { runAlertCheck } from '../alerts/checker.js';
import { jobLogger } from '../log/logger.js';

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BACKFILL_LOCK = 'massive:job:backfill';
const SESSION_UPDATE_LOCK = 'massive:job:session-update';

const baseLog = jobLogger('scheduler');

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  baseLog[level](extra ?? {}, msg);
}

async function withLock(
  redis: Redis,
  key: string,
  fn: () => Promise<void>,
): Promise<void> {
  const owner = await tryAcquireLock(redis, key, LOCK_TTL_MS);
  if (!owner) {
    log('warn', 'lock held — skipping firing', { key });
    return;
  }
  try {
    await fn();
  } finally {
    await releaseLock(redis, key, owner);
  }
}

export function registerScheduledJobs(redis: Redis): void {
  // Backfill: run once at startup; the job self-terminates when nothing remains.
  // It publishes universe.updated when symbols flip to backfilled.
  void withLock(redis, BACKFILL_LOCK, async () => {
    await runBackfill(redis);
  }).catch((err: unknown) => {
    log('error', 'backfill failed', { err: String(err) });
  });

  // Session update: 21:30 UTC Mon–Fri (≈16:30 ET, after the close). Appends the
  // just-closed session's intraday bars per symbol (Massive, at the configured
  // resolution) and publishes prices.updated for the freshly-written bars.
  cron.schedule('0 30 21 * * 1-5', () => {
    const now = new Date();
    if (isNyseHoliday(now)) {
      log('info', 'holiday — skipping session update', {
        date: now.toISOString().slice(0, 10),
      });
      return;
    }

    void withLock(redis, SESSION_UPDATE_LOCK, () =>
      runIntradayUpdate(redis),
    ).catch((err: unknown) => {
      log('error', 'session-update failed', { err: String(err) });
    });
  });

  // Alerts: every 5 minutes, check for stuck states (EOD lag, backfill stuck,
  // Massive 429 burst) and fire once per window (item 10).
  cron.schedule('0 */5 * * * *', () => {
    void runAlertCheck(redis).catch((err: unknown) => {
      log('error', 'alert check failed', { err: String(err) });
    });
  });

  log('info', 'scheduler registered (backfill + session-update + alerts)');
}
