import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runIntradayUpdate } from './intraday-update.js';
import { runMetadataRefresh } from './refresh-metadata.js';
import { tryAcquireLock, releaseLock } from './locks.js';
import { seedUniverse } from '../db/seed-universe.js';
import { isNyseHoliday } from '../market/holidays.js';
import { runAlertCheck } from '../alerts/checker.js';
import { jobLogger } from '../log/logger.js';

// Session update appends a single just-closed session — short and time-critical,
// so a tight TTL is right (recover fast if a run crashes near the close).
const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes
// Backfill and the universe refresh can run well over an hour on a large catch-up
// (e.g. the every-3-days reconcile adds members → the next hourly backfill pulls
// their full 2yr history; the metadata refresh is token-bucket limited). The lock
// is released in withLock's finally on normal completion, so this TTL is only a
// crash net — but it MUST exceed the longest plausible run, otherwise an expired
// lock lets the next hourly firing start a *second* concurrent backfill.
const LONG_LOCK_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const BACKFILL_LOCK = 'massive:job:backfill';
const SESSION_UPDATE_LOCK = 'massive:job:session-update';
const UNIVERSE_REFRESH_LOCK = 'massive:job:universe-refresh';

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
  ttlMs: number = LOCK_TTL_MS,
): Promise<void> {
  const owner = await tryAcquireLock(redis, key, ttlMs);
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
  // Backfill: run once at startup for an immediate post-deploy catch-up; the job
  // self-terminates when nothing remains. It publishes universe.updated when
  // symbols flip to backfilled.
  void withLock(
    redis,
    BACKFILL_LOCK,
    async () => {
      await runBackfill(redis);
    },
    LONG_LOCK_TTL_MS,
  ).catch((err: unknown) => {
    log('error', 'backfill failed', { err: String(err) });
  });

  // Backfill: hourly. A no-op when the corpus is current (it self-terminates with
  // nothing pending); does real work after the M/W/Sat reconcile adds members,
  // pulling their history. The long lock TTL keeps a slow run from colliding with
  // the next hourly firing.
  cron.schedule('0 0 * * * *', () => {
    void withLock(
      redis,
      BACKFILL_LOCK,
      async () => {
        await runBackfill(redis);
      },
      LONG_LOCK_TTL_MS,
    ).catch((err: unknown) => {
      log('error', 'scheduled backfill failed', { err: String(err) });
    });
  });

  // Universe refresh: 00:00 UTC every Mon/Wed/Sat. Pulls the live S&P 500 list
  // from Wikipedia (default 0.1 departure cap — the mass-retirement guard), then
  // refreshes metadata/branding directly after so newly-added members get names +
  // logos. Their price history is filled by the hourly backfill above.
  cron.schedule('0 0 0 * * 1,3,6', () => {
    void withLock(
      redis,
      UNIVERSE_REFRESH_LOCK,
      async () => {
        await seedUniverse();
        await runMetadataRefresh(redis);
      },
      LONG_LOCK_TTL_MS,
    ).catch((err: unknown) => {
      log('error', 'universe refresh failed', { err: String(err) });
    });
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

  log(
    'info',
    'scheduler registered (startup + hourly backfill, M/W/Sat universe refresh + metadata, session-update, alerts)',
  );
}
