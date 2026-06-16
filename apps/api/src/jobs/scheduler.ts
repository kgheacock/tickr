import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runIntradayUpdate } from './intraday-update.js';
import { runCloseCapture } from './close-capture.js';
import { runMetadataRefresh } from './refresh-metadata.js';
import { tryAcquireLock, releaseLock, isLockHeld } from './locks.js';
import { seedUniverse } from '../db/seed-universe.js';
import { isRegularSession, isNyseHoliday } from '../market/holidays.js';
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
const CLOSE_CAPTURE_LOCK = 'finnhub:job:close-capture';

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
  // Dev escape hatch: skip every job that reaches the external data APIs (Massive
  // + the Wikipedia universe pull) so `pnpm dev` runs the platform without a real
  // MASSIVE_API_KEY and without burning the shared free-tier rate budget. Default
  // off — prod never sets it, and scripts/deploy.sh refuses to deploy if it is.
  // The DB/Redis-only alerts job still runs (its webhook fetch is gated on a URL
  // that dev won't have).
  const remoteJobsDisabled = process.env['TICKR_DISABLE_REMOTE_JOBS'] === '1';
  if (remoteJobsDisabled) {
    log(
      'warn',
      'TICKR_DISABLE_REMOTE_JOBS=1 — skipping all external-data jobs (backfill, intraday sweep, universe refresh). NEVER enable this in production.',
    );
  }

  // Backfill hydrates the ~2yr history of not-yet-backfilled symbols (e.g. members
  // added by the M/W/Sat reconcile). It shares the Massive rate bucket with the
  // intraday sweep, so it is gated to run *outside* the regular session — during
  // market hours the whole budget belongs to the live tail. Self-terminates when
  // nothing is pending, so an off-hours firing is a no-op once the corpus is full.
  const backfillIfOffHours = (trigger: string): void => {
    const now = new Date();
    if (isRegularSession(now)) {
      log('info', 'backfill skipped — market open (runs off-hours only)', {
        trigger,
      });
      return;
    }
    void withLock(
      redis,
      BACKFILL_LOCK,
      async () => {
        // Saturday only: the weekend catch-up sweep (below) is the first Massive
        // job that fires in the same off-hours window as this backfill, and both
        // draw the single global token bucket (massive:bucket). Yield the rate
        // budget to an active sweep so it pulls Friday's tail at full throughput;
        // the next hourly firing resumes the backfill once the sweep releases
        // SESSION_UPDATE_LOCK. Scoped to Saturday so an orphaned session lock (a
        // mid-session weekday deploy, see intraday-update) never stalls the
        // weekday off-hours backfill.
        if (
          now.getUTCDay() === 6 &&
          (await isLockHeld(redis, SESSION_UPDATE_LOCK))
        ) {
          log('info', 'backfill deferred — Saturday catch-up sweep active', {
            trigger,
          });
          return;
        }
        await runBackfill(redis);
      },
      LONG_LOCK_TTL_MS,
    ).catch((err: unknown) => {
      log('error', 'backfill failed', { err: String(err), trigger });
    });
  };

  // Startup catch-up (off-hours) + hourly thereafter.
  if (!remoteJobsDisabled) {
    backfillIfOffHours('startup');
    cron.schedule('0 0 * * * *', () => backfillIfOffHours('hourly'));
  }

  // Intraday live tail: every 5 min during the regular session (09:30–16:00 ET,
  // DST-aware, holidays excluded). At 5 req/min a full ~500-symbol sweep takes
  // ~100 min, so SESSION_UPDATE_LOCK serializes the firings into continuous,
  // back-to-back best-effort sweeps (each symbol's tail is therefore up to ~one
  // sweep stale — a known free-tier trade-off). Each sweep appends the latest
  // bars, publishes prices.updated, and stamps the EOD health signal. Because the
  // sweep re-fetches a trailing multi-day window with ON CONFLICT inserts, any
  // bars a near-close sweep missed are filled by the next session — self-healing,
  // so no separate post-close pass is scheduled.
  if (!remoteJobsDisabled) {
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
  }

  // Saturday catch-up sweep: 13:30 UTC (~09:30 ET). Friday's bars are 403'd on
  // Friday itself (the free tier never serves the current trading day) and the
  // in-session sweep above never runs on the weekend, so Friday's prices would
  // otherwise not reach the authoritative price_bar store until Monday's session.
  // The free tier *does* serve the prior trading day by the weekend (verified
  // 2026-06-14: Friday 06-12 bars were available), so a single Saturday sweep pulls
  // Friday's now-available tail forward by two days. runIntradayUpdate re-fetches a
  // trailing multi-day window with ON CONFLICT inserts — the same self-healing
  // append the weekday sweep does, just unconditional (Saturday is never a regular
  // session, so there is no session gate to apply). Reuses SESSION_UPDATE_LOCK so
  // it can't double-run, and the 13:30 mid-hour slot means it holds that lock
  // before the top-of-hour backfill fires — backfillIfOffHours then defers to it,
  // keeping the shared Massive rate bucket undivided. The Friday session_close
  // capture (item 30) still settles the FS scorer; this fills the price_bar store
  // that charts and backtests read.
  if (!remoteJobsDisabled) {
    cron.schedule('0 30 13 * * 6', () => {
      void withLock(
        redis,
        SESSION_UPDATE_LOCK,
        () => runIntradayUpdate(redis),
        LONG_LOCK_TTL_MS,
      ).catch((err: unknown) => {
        log('error', 'Saturday catch-up sweep failed', { err: String(err) });
      });
    });
  }

  // Universe refresh: 00:00 UTC every Mon/Wed/Sat (off-hours). Pulls the live S&P
  // 500 list from Wikipedia (default 0.1 departure cap — the mass-retirement
  // guard), then refreshes metadata/branding directly after so newly-added members
  // get names + logos. Their price history is filled by the off-hours backfill.
  if (!remoteJobsDisabled) {
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
  }

  // Daily early close capture: every trading day at 21:30 UTC (~17:30 ET, after
  // the 16:00 close; item 30, extended from Friday-only). Massive's free tier
  // doesn't serve the current day and the intraday sweep never runs on weekends,
  // so a session's close wouldn't reach price_bar until the next trading day
  // (Friday's not until Monday). This sweeps the playable corpus through Finnhub
  // /quote (where `c` has frozen at the official close by 21:00 UTC) into the
  // provisional session_close store, giving every trading day's close hours-to-
  // days before Massive's 15-min bars backfill it. session_close and price_bar
  // stay two PARALLEL stores (joinable later, never merged here): Massive remains
  // the authoritative 15-min source for price_bar; this only fills session_close.
  // Skipped on NYSE holidays: there is no fresh close, and because the prior
  // session was already captured the day it closed, mostRecentSessionDate would
  // otherwise just re-sweep an already-stored close for ~9 min of Finnhub budget.
  // The sweep runs under its own lock. Gated off in dev with the other
  // external-data jobs — it hits the Finnhub API.
  if (!remoteJobsDisabled) {
    cron.schedule('0 30 21 * * 1-5', () => {
      const now = new Date();
      if (isNyseHoliday(now)) {
        log('info', 'holiday — skipping close capture', {
          date: now.toISOString().slice(0, 10),
        });
        return;
      }
      void withLock(redis, CLOSE_CAPTURE_LOCK, () =>
        runCloseCapture(redis),
      ).catch((err: unknown) => {
        log('error', 'close capture failed', { err: String(err) });
      });
    });
  }

  // Alerts: every 5 minutes, check for stuck states (EOD lag, backfill stuck,
  // Massive 429 burst) and fire once per window (item 10).
  cron.schedule('0 */5 * * * *', () => {
    void runAlertCheck(redis).catch((err: unknown) => {
      log('error', 'alert check failed', { err: String(err) });
    });
  });

  log(
    'info',
    remoteJobsDisabled
      ? 'scheduler registered (alerts only — external-data jobs disabled via TICKR_DISABLE_REMOTE_JOBS)'
      : 'scheduler registered (off-hours backfill, intraday live tail, M/W/Sat universe refresh + metadata, daily close capture, alerts)',
  );
}
