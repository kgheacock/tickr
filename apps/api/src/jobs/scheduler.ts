import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runIntradayUpdate } from './intraday-update.js';
import { runMetadataRefresh } from './refresh-metadata.js';
import { tryAcquireLock, releaseLock } from './locks.js';
import { seedUniverse } from '../db/seed-universe.js';
import { isRegularSession, isNyseHoliday } from '../market/holidays.js';
import { runAlertCheck } from '../alerts/checker.js';
import { runClassifier } from '../fantasy/classify.js';
import { lockLineups, isFirstTradingDayOfWeek } from '../fantasy/lock.js';
import { runWeeklyScoring } from './scoring.js';
import { runWaivers } from '../fantasy/waivers.js';
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
const BACKFILL_LOCK = 'massive:job:backfill';
const SESSION_UPDATE_LOCK = 'massive:job:session-update';
const UNIVERSE_REFRESH_LOCK = 'massive:job:universe-refresh';
const CLASSIFY_LOCK = 'fs:job:classify';
const LINEUP_LOCK_LOCK = 'fs:job:lineup-lock';
const SCORING_LOCK = 'fs:job:scoring';
const WAIVER_LOCK = 'fs:job:waivers';

// Fixed UTC-5 (ET standard) offset, matching holidays.ts / lock.ts. The scoring
// crons fire at ~21:35 UTC, well clear of the midnight boundary.
const ET_OFFSET_MS = 5 * 60 * 60 * 1000;
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

/** The Friday of `now`'s week (ET) — today on Friday, the coming Friday Mon–Thu. */
function currentFriday(now: Date): Date {
  const et = new Date(now.getTime() - ET_OFFSET_MS);
  const dow = et.getUTCDay(); // 0 = Sun … 5 = Fri … 6 = Sat
  const daysUntilFriday = (5 - dow + 7) % 7;
  return new Date(now.getTime() + daysUntilFriday * DAY_MS);
}

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

  // Fantasy Street player classifier (FS-02): weekly, Sunday 06:00 UTC. Reads
  // price_bar and recomputes fs_player_classification. Idempotent and cheap;
  // also runnable on demand via runClassifier(pool).
  cron.schedule('0 0 6 * * 0', () => {
    void withLock(redis, CLASSIFY_LOCK, async () => {
      const n = await runClassifier(pool);
      log('info', 'classifier run complete', { symbols: n });
    }).catch((err: unknown) => {
      log('error', 'classifier failed', { err: String(err) });
    });
  });

  // FS-04 lineup lock: market open (~14:30 UTC) Mon–Fri, but only on the week's
  // first NYSE trading day — so a holiday Monday defers the lock to the next
  // open. Freezes every active league's lineups and auto-fills incomplete ones.
  cron.schedule('0 30 14 * * 1-5', () => {
    const now = new Date();
    if (!isFirstTradingDayOfWeek(now)) return;

    void withLock(redis, LINEUP_LOCK_LOCK, async () => {
      const result = await lockLineups(
        pool,
        { week: currentWeek(), now },
        redis,
      );
      log('info', 'lineup lock complete', result);
    }).catch((err: unknown) => {
      log('error', 'lineup lock failed', { err: String(err) });
    });
  });

  // FS-05 weekly settle: Friday 21:35 UTC, after the close. Scoring is
  // point-in-time (returns.ts: close at-or-before the anchor, `ts <= weekEnd`),
  // so it settles off the *last available* close rather than requiring Friday's
  // 16:00 bar specifically — important since main folded the dedicated post-close
  // append into the intraday live tail, which is gated to the regular session and
  // may not have swept every symbol's final bar by 21:35 (a ~100-min sweep can end
  // before the 15-min-delayed close lands). The next session's trailing-window
  // sweep self-heals any gap; a holiday-short week likewise resolves to the last
  // close, so no holiday skip here. See FS-13 ledger (post-close sourcing note).
  cron.schedule('0 35 21 * * 5', () => {
    const now = new Date();
    void withLock(redis, SCORING_LOCK, async () => {
      const result = await runWeeklyScoring(
        pool,
        { week: currentWeek(), weekEnd: currentFriday(now) },
        redis,
      );
      log('info', 'weekly settle complete', result);
    }).catch((err: unknown) => {
      log('error', 'weekly settle failed', { err: String(err) });
    });
  });

  // FS-05 provisional scores: Mon–Thu 21:35 UTC, after the close. Best-effort
  // in-week totals off the last available close (same point-in-time read as the
  // settle — whatever the intraday tail has appended so far that day, no fresh
  // append is forced); pushed as matchup.updated and never persisted. Skipped on
  // a holiday (no fresh bars to score).
  cron.schedule('0 35 21 * * 1-4', () => {
    const now = new Date();
    if (isNyseHoliday(now)) {
      log('info', 'holiday — skipping provisional scoring', {
        date: now.toISOString().slice(0, 10),
      });
      return;
    }
    void withLock(redis, SCORING_LOCK, async () => {
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
    }).catch((err: unknown) => {
      log('error', 'provisional scoring failed', { err: String(err) });
    });
  });

  // FS-07 waiver run: Friday 21:45 UTC, ~10 min after the weekly settle has
  // rebuilt standings (the reverse-standings priority depends on them). Opens
  // the between-weeks window — every active league whose week has just settled
  // gets its queued add/drop claims resolved before Monday's lineup lock. A
  // mid-week firing is a no-op: runWaivers skips any league still locked.
  cron.schedule('0 45 21 * * 5', () => {
    void withLock(redis, WAIVER_LOCK, async () => {
      const result = await runWaivers(pool, {}, redis);
      log('info', 'waiver run complete', result);
    }).catch((err: unknown) => {
      log('error', 'waiver run failed', { err: String(err) });
    });
  });

  log(
    'info',
    'scheduler registered (off-hours backfill, intraday live tail, M/W/Sat universe refresh + metadata, alerts + classifier + lineup-lock + scoring + waivers)',
  );
}
