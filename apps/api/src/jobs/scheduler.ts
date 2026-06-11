import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runIntradayUpdate } from './intraday-update.js';
import { runMetadataRefresh } from './refresh-metadata.js';
import { tryAcquireLock, releaseLock } from './locks.js';
import { seedUniverse } from '../db/seed-universe.js';
import { isRegularSession } from '../market/holidays.js';
import { runAlertCheck } from '../alerts/checker.js';
import { jobLogger } from '../log/logger.js';

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes (default crash net)
// Every Massive-backed job — the intraday sweep, backfill, the universe refresh —
// can run well over an hour. At 5 req/min a full ~500-symbol sweep is ~100 min,
// and a large backfill catch-up is longer still. withLock releases in its finally
// on normal completion, so this TTL is only a crash net — but it MUST exceed the
// longest plausible run: a shorter TTL would expire mid-run and let the next
// firing acquire the lock and start a *second* concurrent run, multiplying spend
// against the shared rate bucket.
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
  // The intraday sweep fires every 5 min but a sweep holds the lock for ~100 min,
  // so most firings are expected skips — log those at debug to avoid warn spam.
  quietSkip = false,
): Promise<void> {
  const owner = await tryAcquireLock(redis, key, ttlMs);
  if (!owner) {
    if (quietSkip) baseLog.debug({ key }, 'lock held — skipping firing (busy)');
    else log('warn', 'lock held — skipping firing', { key });
    return;
  }
  try {
    await fn();
  } finally {
    await releaseLock(redis, key, owner);
  }
}

export function registerScheduledJobs(redis: Redis): void {
  // Backfill hydrates the ~2yr history of not-yet-backfilled symbols (e.g. members
  // added by the M/W/Sat reconcile). It shares the Massive rate bucket with the
  // intraday sweep, so it is gated to run *outside* the regular session — during
  // market hours the whole budget belongs to the live tail. Self-terminates when
  // nothing is pending, so an off-hours firing is a no-op once the corpus is full.
  const backfillIfOffHours = (trigger: string): void => {
    if (isRegularSession(new Date())) {
      log('info', 'backfill skipped — market open (runs off-hours only)', {
        trigger,
      });
      return;
    }
    void withLock(
      redis,
      BACKFILL_LOCK,
      async () => {
        await runBackfill(redis);
      },
      LONG_LOCK_TTL_MS,
    ).catch((err: unknown) => {
      log('error', 'backfill failed', { err: String(err), trigger });
    });
  };

  // Startup catch-up (off-hours) + hourly thereafter.
  backfillIfOffHours('startup');
  cron.schedule('0 0 * * * *', () => backfillIfOffHours('hourly'));

  // Intraday live tail: every 5 min during the regular session (09:30–16:00 ET,
  // DST-aware, holidays excluded). At 5 req/min a full ~500-symbol sweep takes
  // ~100 min, so SESSION_UPDATE_LOCK serializes the firings into continuous,
  // back-to-back best-effort sweeps (each symbol's tail is therefore up to ~one
  // sweep stale — a known free-tier trade-off). Each sweep appends the latest
  // bars, publishes prices.updated, and stamps the EOD health signal. Because the
  // sweep re-fetches a trailing multi-day window with ON CONFLICT inserts, any
  // bars a near-close sweep missed are filled by the next session — self-healing,
  // so no separate post-close pass is scheduled.
  cron.schedule('0 */5 * * * *', () => {
    if (!isRegularSession(new Date())) return;
    void withLock(
      redis,
      SESSION_UPDATE_LOCK,
      () => runIntradayUpdate(redis),
      LONG_LOCK_TTL_MS,
      true,
    ).catch((err: unknown) => {
      log('error', 'intraday sweep failed', { err: String(err) });
    });
  });

  // Universe refresh: 00:00 UTC every Mon/Wed/Sat (off-hours). Pulls the live S&P
  // 500 list from Wikipedia (default 0.1 departure cap — the mass-retirement
  // guard), then refreshes metadata/branding directly after so newly-added members
  // get names + logos. Their price history is filled by the off-hours backfill.
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

  // Alerts: every 5 minutes, check for stuck states (EOD lag, backfill stuck,
  // Massive 429 burst) and fire once per window (item 10).
  cron.schedule('0 */5 * * * *', () => {
    void runAlertCheck(redis).catch((err: unknown) => {
      log('error', 'alert check failed', { err: String(err) });
    });
  });

  log(
    'info',
    'scheduler registered (off-hours backfill, intraday live tail, M/W/Sat universe refresh + metadata, alerts)',
  );
}
