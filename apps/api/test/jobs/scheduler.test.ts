import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

// Capture cron registrations and stub out everything the scheduler touches so the
// test asserts the *schedule definition* (cron expressions, session gating,
// locking) without a Redis or Postgres dependency. vi.hoisted keeps the mock fns
// available inside the hoisted vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  runBackfill: vi.fn(),
  runIntradayUpdate: vi.fn(),
  runMetadataRefresh: vi.fn(),
  seedUniverse: vi.fn(),
  runAlertCheck: vi.fn(),
  isRegularSession: vi.fn(),
  tryAcquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

vi.mock('node-cron', () => ({ default: { schedule: mocks.schedule } }));
vi.mock('../../src/jobs/backfill.js', () => ({
  runBackfill: mocks.runBackfill,
}));
vi.mock('../../src/jobs/intraday-update.js', () => ({
  runIntradayUpdate: mocks.runIntradayUpdate,
}));
vi.mock('../../src/jobs/refresh-metadata.js', () => ({
  runMetadataRefresh: mocks.runMetadataRefresh,
}));
vi.mock('../../src/db/seed-universe.js', () => ({
  seedUniverse: mocks.seedUniverse,
}));
vi.mock('../../src/alerts/checker.js', () => ({
  runAlertCheck: mocks.runAlertCheck,
}));
vi.mock('../../src/market/holidays.js', () => ({
  isRegularSession: mocks.isRegularSession,
}));
vi.mock('../../src/jobs/locks.js', () => ({
  tryAcquireLock: mocks.tryAcquireLock,
  releaseLock: mocks.releaseLock,
}));

import { registerScheduledJobs } from '../../src/jobs/scheduler.js';

const BACKFILL_LOCK = 'massive:job:backfill';
const SESSION_UPDATE_LOCK = 'massive:job:session-update';
const UNIVERSE_REFRESH_LOCK = 'massive:job:universe-refresh';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const fakeRedis = {} as unknown as Redis;

/** Find the first callback registered for a given cron expression. */
function callbackFor(expr: string): () => void {
  const call = mocks.schedule.mock.calls.find((c) => c[0] === expr);
  if (!call) throw new Error(`no cron registered for "${expr}"`);
  return call[1] as () => void;
}

function acquiredKeys(): string[] {
  return mocks.tryAcquireLock.mock.calls.map((c) => c[1] as string);
}

describe('registerScheduledJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryAcquireLock.mockResolvedValue('owner-token');
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.runBackfill.mockResolvedValue({ completed: 0, failed: [] });
    mocks.runIntradayUpdate.mockResolvedValue(undefined);
    mocks.seedUniverse.mockResolvedValue(undefined);
    mocks.runMetadataRefresh.mockResolvedValue({
      total: 0,
      metadata: 0,
      logos: 0,
      icons: 0,
      failed: [],
    });
    mocks.runAlertCheck.mockResolvedValue(undefined);
    // Default to off-hours so the startup backfill runs; flip per-test.
    mocks.isRegularSession.mockReturnValue(false);
  });

  it('registers exactly the expected cron schedules', () => {
    registerScheduledJobs(fakeRedis);

    const exprs = mocks.schedule.mock.calls.map((c) => c[0]);
    expect(exprs).toContain('0 0 * * * *'); // hourly backfill
    expect(exprs).toContain('0 */5 * * * *'); // intraday live tail + alerts
    expect(exprs).toContain('0 0 0 * * 1,3,6'); // universe refresh Mon/Wed/Sat
    // backfill, intraday, universe, alerts (the post-close EOD cron was dropped)
    expect(mocks.schedule).toHaveBeenCalledTimes(4);
  });

  describe('backfill (off-hours only)', () => {
    it('runs the startup catch-up under the backfill lock with the long TTL when the market is closed', () => {
      mocks.isRegularSession.mockReturnValue(false);
      registerScheduledJobs(fakeRedis);

      expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
        fakeRedis,
        BACKFILL_LOCK,
        SIX_HOURS_MS,
      );
    });

    it('skips backfill entirely while the market is open', async () => {
      mocks.isRegularSession.mockReturnValue(true);
      registerScheduledJobs(fakeRedis);

      // hourly firing during the session is also a no-op
      callbackFor('0 0 * * * *')();
      await Promise.resolve();

      expect(mocks.runBackfill).not.toHaveBeenCalled();
      expect(acquiredKeys()).not.toContain(BACKFILL_LOCK);
    });

    it('hourly firing runs the backfill off-hours under the long TTL', async () => {
      mocks.isRegularSession.mockReturnValue(false);
      registerScheduledJobs(fakeRedis);

      callbackFor('0 0 * * * *')();

      await vi.waitFor(() => expect(mocks.runBackfill).toHaveBeenCalled());
      expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
        fakeRedis,
        BACKFILL_LOCK,
        SIX_HOURS_MS,
      );
    });
  });

  describe('intraday live tail (session only)', () => {
    it('sweeps under the session lock with the long TTL during the session', async () => {
      mocks.isRegularSession.mockReturnValue(true);
      registerScheduledJobs(fakeRedis);

      callbackFor('0 */5 * * * *')(); // first registration is the intraday sweep

      await vi.waitFor(() =>
        expect(mocks.runIntradayUpdate).toHaveBeenCalled(),
      );
      expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
        fakeRedis,
        SESSION_UPDATE_LOCK,
        SIX_HOURS_MS,
      );
    });

    it('is a no-op outside the session (no lock, no fetch)', async () => {
      mocks.isRegularSession.mockReturnValue(false);
      registerScheduledJobs(fakeRedis);

      callbackFor('0 */5 * * * *')();
      await Promise.resolve();

      expect(mocks.runIntradayUpdate).not.toHaveBeenCalled();
      expect(acquiredKeys()).not.toContain(SESSION_UPDATE_LOCK);
    });
  });

  describe('universe refresh (Mon/Wed/Sat)', () => {
    it('reconciles then refreshes metadata, in that order, under its own lock', async () => {
      const order: string[] = [];
      mocks.seedUniverse.mockImplementation(async () => {
        order.push('seed');
      });
      mocks.runMetadataRefresh.mockImplementation(async () => {
        order.push('metadata');
        return { total: 0, metadata: 0, logos: 0, icons: 0, failed: [] };
      });

      registerScheduledJobs(fakeRedis);
      callbackFor('0 0 0 * * 1,3,6')();

      await vi.waitFor(() => expect(order).toEqual(['seed', 'metadata']));
      expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
        fakeRedis,
        UNIVERSE_REFRESH_LOCK,
        SIX_HOURS_MS,
      );
    });

    it('skips the firing when the lock is already held', async () => {
      mocks.tryAcquireLock.mockResolvedValue(null);

      registerScheduledJobs(fakeRedis);
      callbackFor('0 0 0 * * 1,3,6')();
      await Promise.resolve();

      expect(mocks.seedUniverse).not.toHaveBeenCalled();
      expect(mocks.runMetadataRefresh).not.toHaveBeenCalled();
    });
  });
});
