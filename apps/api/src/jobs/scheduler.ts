import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runIntradayUpdate } from './intraday-update.js';
import { runCloseCapture } from './close-capture.js';
import { runMetadataRefresh } from './refresh-metadata.js';
import { tryAcquireLock, releaseLock, isLockHeld } from './locks.js';
import {
  JOB_LOCKS,
  recordJobStart,
  recordJobResult,
  recordJobSkip,
  type JobName,
} from './status.js';
import { seedUniverse } from '../db/seed-universe.js';
import {
  isRegularSession,
  isNyseHoliday,
  nyseRegularCloseAnchor,
  currentFriday,
} from '../market/holidays.js';
import { runAlertCheck } from '../alerts/checker.js';
import { runClassifier } from '../fantasy/classify.js';
import { lockLineups, isFirstTradingDayOfWeek } from '../fantasy/lock.js';
import { runWeeklyScoring } from './scoring.js';
import { runWaivers } from '../fantasy/waivers.js';
import { runLineupReminders } from '../fantasy/reminders.js';
import { pool } from '../db/pool.js';
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
// Lock keys come from the job registry (jobs/status.ts) so the scheduler and the
// status layer share one definition. Aliased to the local names the job bodies
// already use.
const BACKFILL_LOCK = JOB_LOCKS.backfill;
const SESSION_UPDATE_LOCK = JOB_LOCKS.sessionUpdate;
const UNIVERSE_REFRESH_LOCK = JOB_LOCKS.universeRefresh;
const CLOSE_CAPTURE_LOCK = JOB_LOCKS.closeCapture;
const CLASSIFY_LOCK = JOB_LOCKS.classify;
const LINEUP_LOCK_LOCK = JOB_LOCKS.lineupLock;
const SCORING_LOCK = JOB_LOCKS.scoring;
const WAIVER_LOCK = JOB_LOCKS.waivers;
const LINEUP_REMINDER_LOCK = JOB_LOCKS.lineupReminder;

// The scoring crons fire at ~21:35 UTC, well clear of the midnight boundary, so
// the ET calendar date is stable when picking the week's Friday (currentFriday).
const DAY_MS = 24 * 60 * 60 * 1000;

// MVP scope (intentional for this merge): the automated lineup-lock, weekly-settle
// and provisional-scoring crons drive a single scoring week. Item 06's round-robin
// schedule supports multiple weeks, but auto-advancing the *cron* target across
// weeks is deferred — weeks >= 2 are settled on demand until the season-week
// derivation lands. Tracked as a follow-up in TODO/fantasy-street/06-matchups-and-standings.md.
// TODO(FS-06): derive the scoring week from the season schedule (start date + week length).
function currentWeek(): number {
  return 1;
}

const baseLog = jobLogger('scheduler');

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  baseLog[level](extra ?? {}, msg);
}

interface JobLockOpts {
  /** Status key from the job registry (jobs/status.ts) — distinct per job even
   *  when two jobs share a lock key, so status is attributed correctly. */
  name: JobName;
  /** Redis lock key serializing this job's firings. */
  key: string;
  /** Lock + running-marker TTL crash-net (default LOCK_TTL_MS). */
  ttlMs?: number;
  // The intraday sweep fires every 5 min but a sweep holds the lock for ~100 min,
  // so most firings are expected skips — log those at debug to avoid warn spam.
  quietSkip?: boolean;
}

/**
 * Run `fn` with its run status recorded (start/finish/outcome/duration/error)
 * under the registry `name`. The single instrumentation seam — withLock and the
 * lock-less alert check both go through here. All status writes are best-effort
 * (`.catch`): a Redis hiccup in the observability path must never break the job
 * it's observing.
 */
async function recordedRun(
  redis: Redis,
  name: JobName,
  fn: () => Promise<unknown>,
  ttlMs?: number,
): Promise<void> {
  await recordJobStart(redis, name, ttlMs).catch(() => undefined);
  const startedAt = Date.now();
  try {
    await fn();
    await recordJobResult(redis, name, {
      ok: true,
      durationMs: Date.now() - startedAt,
    }).catch(() => undefined);
  } catch (err) {
    await recordJobResult(redis, name, {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    }).catch(() => undefined);
    throw err;
  }
}

async function withLock(
  redis: Redis,
  opts: JobLockOpts,
  fn: () => Promise<void>,
): Promise<void> {
  const { name, key, ttlMs = LOCK_TTL_MS, quietSkip = false } = opts;
  const owner = await tryAcquireLock(redis, key, ttlMs);
  if (!owner) {
    if (quietSkip) baseLog.debug({ key }, 'lock held — skipping firing (busy)');
    else log('warn', 'lock held — skipping firing', { key });
    await recordJobSkip(redis, name).catch(() => undefined);
    return;
  }
  try {
    await recordedRun(redis, name, fn, ttlMs);
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
      { name: 'backfill', key: BACKFILL_LOCK, ttlMs: LONG_LOCK_TTL_MS },
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
        {
          name: 'intraday-sweep',
          key: SESSION_UPDATE_LOCK,
          ttlMs: LONG_LOCK_TTL_MS,
          quietSkip: true,
        },
        () => runIntradayUpdate(redis),
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
        {
          name: 'saturday-catchup',
          key: SESSION_UPDATE_LOCK,
          ttlMs: LONG_LOCK_TTL_MS,
        },
        () => runIntradayUpdate(redis),
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
        {
          name: 'universe-refresh',
          key: UNIVERSE_REFRESH_LOCK,
          ttlMs: LONG_LOCK_TTL_MS,
        },
        async () => {
          await seedUniverse();
          await runMetadataRefresh(redis);
        },
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
      void withLock(
        redis,
        { name: 'close-capture', key: CLOSE_CAPTURE_LOCK },
        () => runCloseCapture(redis),
      ).catch((err: unknown) => {
        log('error', 'close capture failed', { err: String(err) });
      });
    });
  }

  // Alerts: every 5 minutes, check for stuck states (EOD lag, backfill stuck,
  // Massive 429 burst) and fire once per window (item 10).
  cron.schedule('0 */5 * * * *', () => {
    void recordedRun(redis, 'alert-check', () => runAlertCheck(redis)).catch(
      (err: unknown) => {
        log('error', 'alert check failed', { err: String(err) });
      },
    );
  });

  // Fantasy Street player classifier (FS-02): weekly, Sunday 06:00 UTC. Reads
  // price_bar and recomputes fs_player_classification. Idempotent and cheap;
  // also runnable on demand via runClassifier(pool).
  cron.schedule('0 0 6 * * 0', () => {
    void withLock(
      redis,
      { name: 'classifier', key: CLASSIFY_LOCK },
      async () => {
        const n = await runClassifier(pool);
        log('info', 'classifier run complete', { symbols: n });
      },
    ).catch((err: unknown) => {
      log('error', 'classifier failed', { err: String(err) });
    });
  });

  // FS-04 lineup lock: market open (~14:30 UTC) Mon–Fri, but only on the week's
  // first NYSE trading day — so a holiday Monday defers the lock to the next
  // open. Freezes every active league's lineups and auto-fills incomplete ones.
  cron.schedule('0 30 14 * * 1-5', () => {
    const now = new Date();
    if (!isFirstTradingDayOfWeek(now)) return;

    void withLock(
      redis,
      { name: 'lineup-lock', key: LINEUP_LOCK_LOCK },
      async () => {
        const result = await lockLineups(
          pool,
          { week: currentWeek(), now },
          redis,
        );
        log('info', 'lineup lock complete', result);
      },
    ).catch((err: unknown) => {
      log('error', 'lineup lock failed', { err: String(err) });
    });
  });

  // FS-11 lineup reminders: Sunday evening + each weekday morning before the
  // 14:30 UTC lock. Nudges managers whose scoring-week lineup is still
  // incomplete; deduped per (manager, week) at the DB so it fires once, and
  // incompleteManagers skips already-locked lineups — so once a manager sets
  // (or the week locks) the morning ticks go quiet. The weekday firings make it
  // holiday-aware for free: a holiday Monday defers the lock, and the Tue/Wed
  // morning nudge keeps reminding until the real open locks. Targets
  // currentWeek() (MVP = 1), matching the lock/scoring crons.
  const fireLineupReminders = (trigger: string): void => {
    void withLock(
      redis,
      { name: 'lineup-reminders', key: LINEUP_REMINDER_LOCK },
      async () => {
        const result = await runLineupReminders(
          pool,
          { week: currentWeek() },
          redis,
        );
        log('info', 'lineup reminders complete', { ...result, trigger });
      },
    ).catch((err: unknown) => {
      log('error', 'lineup reminders failed', { err: String(err), trigger });
    });
  };
  cron.schedule('0 0 18 * * 0', () => fireLineupReminders('sunday'));
  cron.schedule('0 0 13 * * 1-5', () => fireLineupReminders('weekday-am'));

  // FS-05 weekly settle: Friday 21:35 UTC, after the close. runWeeklyScoring first
  // captures the just-closed bars for exactly the rostered symbols (main folded
  // the dedicated post-close append into the session-gated intraday tail, which
  // may not have swept them all by now), then scores every league off the
  // regular-session close (16:00 ET) — `weekEnd`/`baselineAt` below — so all
  // symbols and the prior-week baseline are valued at the *same* point in the
  // trading day rather than uneven after-hours prints. A holiday-short week
  // resolves to the last close at-or-before the anchor, so no holiday skip here.
  cron.schedule('0 35 21 * * 5', () => {
    const now = new Date();
    const friday = currentFriday(now);
    // Anchor both endpoints at the regular-session close (16:00 ET), not the
    // settle wall-clock — `price_bar` carries extended-hours bars, so a settle-time
    // anchor would value each symbol at an uneven after-hours print. Baseline is
    // re-derived zone-aware (not weekEnd − 7d) so a DST week stays at 16:00 ET.
    const weekEnd = nyseRegularCloseAnchor(friday);
    const baselineAt = nyseRegularCloseAnchor(
      new Date(friday.getTime() - 7 * DAY_MS),
    );
    void withLock(
      redis,
      { name: 'weekly-settle', key: SCORING_LOCK },
      async () => {
        const result = await runWeeklyScoring(
          pool,
          { week: currentWeek(), weekEnd, baselineAt },
          redis,
        );
        log('info', 'weekly settle complete', result);
      },
    ).catch((err: unknown) => {
      log('error', 'weekly settle failed', { err: String(err) });
    });
  });

  // FS-05 provisional scores: Mon–Thu 21:35 UTC, after the close. Best-effort
  // in-week totals off the last available close (asOf = now, whatever the intraday
  // tail has appended so far — no close capture or regular-close re-anchor here,
  // unlike the Friday settle); pushed as scores.updated and never persisted.
  // Skipped on a holiday (no fresh bars to score).
  cron.schedule('0 35 21 * * 1-4', () => {
    const now = new Date();
    if (isNyseHoliday(now)) {
      log('info', 'holiday — skipping provisional scoring', {
        date: now.toISOString().slice(0, 10),
      });
      return;
    }
    void withLock(
      redis,
      { name: 'provisional-scoring', key: SCORING_LOCK },
      async () => {
        const result = await runWeeklyScoring(
          pool,
          {
            week: currentWeek(),
            weekEnd: currentFriday(now),
            provisional: true,
            asOf: now,
          },
          redis,
        );
        log('info', 'provisional scoring complete', result);
      },
    ).catch((err: unknown) => {
      log('error', 'provisional scoring failed', { err: String(err) });
    });
  });

  // FS-07 waiver run: Friday 21:45 UTC, ~10 min after the weekly settle has
  // rebuilt standings (the reverse-standings priority depends on them). Opens
  // the between-weeks window — every active league whose week has just settled
  // gets its queued add/drop claims resolved before Monday's lineup lock. A
  // mid-week firing is a no-op: runWaivers skips any league still locked.
  cron.schedule('0 45 21 * * 5', () => {
    void withLock(redis, { name: 'waivers', key: WAIVER_LOCK }, async () => {
      const result = await runWaivers(pool, {}, redis);
      log('info', 'waiver run complete', result);
    }).catch((err: unknown) => {
      log('error', 'waiver run failed', { err: String(err) });
    });
  });

  log(
    'info',
    remoteJobsDisabled
      ? 'scheduler registered (external-data jobs disabled via TICKR_DISABLE_REMOTE_JOBS — alerts + classifier + lineup-lock + scoring + waivers + lineup-reminders only)'
      : 'scheduler registered (off-hours backfill, intraday live tail, Saturday catch-up sweep, M/W/Sat universe refresh + metadata, daily close capture, alerts + classifier + lineup-lock + scoring + waivers + lineup-reminders)',
  );
}
