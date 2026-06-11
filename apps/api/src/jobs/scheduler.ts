import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runIntradayUpdate } from './intraday-update.js';
import { tryAcquireLock, releaseLock } from './locks.js';
import { isNyseHoliday } from '../market/holidays.js';
import { runAlertCheck } from '../alerts/checker.js';
import { runClassifier } from '../fantasy/classify.js';
import { lockLineups, isFirstTradingDayOfWeek } from '../fantasy/lock.js';
import { runWeeklyScoring } from './scoring.js';
import { pool } from '../db/pool.js';
import { jobLogger } from '../log/logger.js';

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BACKFILL_LOCK = 'massive:job:backfill';
const SESSION_UPDATE_LOCK = 'massive:job:session-update';
const CLASSIFY_LOCK = 'fs:job:classify';
const LINEUP_LOCK_LOCK = 'fs:job:lineup-lock';
const SCORING_LOCK = 'fs:job:scoring';

// Fixed UTC-5 (ET standard) offset, matching holidays.ts / lock.ts. The scoring
// crons fire at ~21:35 UTC, well clear of the midnight boundary.
const ET_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// TODO(FS-06): derive the scoring week from the season schedule. Until then the
// season has a single week; the scoring + lock jobs always target week 1.
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

  // FS-05 weekly settle: Friday 21:35 UTC, just after the session update appends
  // Friday's close. Scores every active league's just-closed week from the
  // Friday close (point-in-time, so a holiday-short week resolves to the last
  // available close), persists it, and publishes score.updated + the final
  // matchup.updated. Runs every Friday — a holiday Friday simply settles off the
  // last close, so no holiday skip here.
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

  // FS-05 provisional scores: Mon–Thu 21:35 UTC, after the day's close lands.
  // Best-effort live totals from the latest close; pushed as matchup.updated and
  // never persisted. Skipped on a holiday (no fresh bars to score).
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

  log(
    'info',
    'scheduler registered (backfill + session-update + alerts + classifier + lineup-lock + scoring)',
  );
}
