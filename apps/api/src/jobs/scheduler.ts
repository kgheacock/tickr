import cron from 'node-cron';
import type { Redis } from 'ioredis';
import { runBackfill } from './backfill.js';
import { runDailyPrice } from './daily-price.js';
import { runSnapshot } from './snapshot.js';
import { tryAcquireLock, releaseLock } from './locks.js';
import { isNyseHoliday } from '../market/holidays.js';

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes
const BACKFILL_LOCK = 'finnhub:job:backfill';
const DAILY_PRICE_LOCK = 'finnhub:job:daily-price';
const SNAPSHOT_LOCK = 'worker:job:snapshot';

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  console[level](
    JSON.stringify({ level, component: 'scheduler', msg, ...extra }),
  );
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
  void withLock(redis, BACKFILL_LOCK, () => runBackfill(redis)).catch(
    (err: unknown) => {
      log('error', 'backfill failed', { err: String(err) });
    },
  );

  // Daily price: 21:30 UTC Mon–Fri (≈16:30 ET).
  cron.schedule('0 30 21 * * 1-5', () => {
    const now = new Date();
    if (isNyseHoliday(now)) {
      log('info', 'holiday — skipping daily price update', {
        date: now.toISOString().slice(0, 10),
      });
      return;
    }

    void withLock(redis, DAILY_PRICE_LOCK, async () => {
      await runDailyPrice(redis);
      // Chain snapshot immediately after prices are updated.
      await withLock(redis, SNAPSHOT_LOCK, () => runSnapshot(redis));
    }).catch((err: unknown) => {
      log('error', 'daily-price/snapshot failed', { err: String(err) });
    });
  });

  log('info', 'scheduler registered (backfill + daily-price + snapshot)');
}
