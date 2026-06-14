import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';

// Capture cron registrations and stub out everything the scheduler touches so the
// test asserts the *schedule definition* (cron expressions, session gating,
// locking) without a Redis or Postgres dependency. vi.hoisted keeps the mock fns
// available inside the hoisted vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  runBackfill: vi.fn(),
  runIntradayUpdate: vi.fn(),
  runCloseCapture: vi.fn(),
  runMetadataRefresh: vi.fn(),
  seedUniverse: vi.fn(),
  runAlertCheck: vi.fn(),
  isRegularSession: vi.fn(),
  tryAcquireLock: vi.fn(),
  releaseLock: vi.fn(),
  isLockHeld: vi.fn(),
}));

vi.mock('node-cron', () => ({ default: { schedule: mocks.schedule } }));
vi.mock('../../src/jobs/backfill.js', () => ({
  runBackfill: mocks.runBackfill,
}));
vi.mock('../../src/jobs/intraday-update.js', () => ({
  runIntradayUpdate: mocks.runIntradayUpdate,
}));
vi.mock('../../src/jobs/close-capture.js', () => ({
  runCloseCapture: mocks.runCloseCapture,
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
  isLockHeld: mocks.isLockHeld,
}));

import { registerScheduledJobs } from '../../src/jobs/scheduler.js';

const BACKFILL_LOCK = 'massive:job:backfill';
const SESSION_UPDATE_LOCK = 'massive:job:session-update';
const UNIVERSE_REFRESH_LOCK = 'massive:job:universe-refresh';
const CLOSE_CAPTURE_LOCK = 'finnhub:job:close-capture';
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
    mocks.runCloseCapture.mockResolvedValue(undefined);
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
    // Default to no sweep in flight so the backfill's Saturday yield is inert.
    mocks.isLockHeld.mockResolvedValue(false);
  });

  it('registers exactly the expected cron schedules', () => {
    registerScheduledJobs(fakeRedis);

    const exprs = mocks.schedule.mock.calls.map((c) => c[0]);
    expect(exprs).toContain('0 0 * * * *'); // hourly backfill
    expect(exprs).toContain('0 */5 * * * *'); // intraday live tail + alerts
    expect(exprs).toContain('0 0 0 * * 1,3,6'); // universe refresh Mon/Wed/Sat
    expect(exprs).toContain('0 30 13 * * 6'); // Saturday catch-up sweep
    expect(exprs).toContain('0 30 21 * * 5'); // Friday early close capture
    // backfill, intraday, Saturday catch-up, universe, close-capture, alerts (the
    // post-close EOD cron was dropped)
    expect(mocks.schedule).toHaveBeenCalledTimes(6);
  });

  it('Friday close capture runs runCloseCapture under its own lock', async () => {
    registerScheduledJobs(fakeRedis);

    callbackFor('0 30 21 * * 5')();

    await vi.waitFor(() =>
      expect(mocks.runCloseCapture).toHaveBeenCalledWith(fakeRedis),
    );
    expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
      fakeRedis,
      CLOSE_CAPTURE_LOCK,
      expect.any(Number),
    );
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

  describe('Saturday catch-up sweep', () => {
    it('sweeps under the session lock regardless of session state (Saturday is never a regular session)', async () => {
      // The sweep must run with no session gate — prove it fires even when
      // isRegularSession reports closed (the weekend default).
      mocks.isRegularSession.mockReturnValue(false);
      registerScheduledJobs(fakeRedis);

      callbackFor('0 30 13 * * 6')();

      await vi.waitFor(() =>
        expect(mocks.runIntradayUpdate).toHaveBeenCalledWith(fakeRedis),
      );
      expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
        fakeRedis,
        SESSION_UPDATE_LOCK,
        SIX_HOURS_MS,
      );
    });

    it('defers the off-hours backfill while the Saturday sweep holds the session lock', async () => {
      // Freeze to a Saturday (2026-06-13) outside market hours so the backfill's
      // Saturday-only yield engages; the sweep is represented as holding the lock.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-13T14:05:00Z'));
      try {
        mocks.isRegularSession.mockReturnValue(false);
        mocks.isLockHeld.mockResolvedValue(true);

        registerScheduledJobs(fakeRedis);
        callbackFor('0 0 * * * *')(); // hourly backfill firing

        await vi.waitFor(() =>
          expect(mocks.isLockHeld).toHaveBeenCalledWith(
            fakeRedis,
            SESSION_UPDATE_LOCK,
          ),
        );
        expect(mocks.runBackfill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not consult the sweep lock on a weekday — an orphaned session lock never stalls the off-hours backfill', async () => {
      // A Wednesday (2026-06-10) off-hours: the Saturday-only guard short-circuits
      // before isLockHeld, so even a stale/orphaned session lock is ignored.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-10T06:00:00Z'));
      try {
        mocks.isRegularSession.mockReturnValue(false);
        mocks.isLockHeld.mockResolvedValue(true); // orphaned lock — must be ignored

        registerScheduledJobs(fakeRedis);
        mocks.runBackfill.mockClear(); // drop the startup firing
        callbackFor('0 0 * * * *')();

        await vi.waitFor(() => expect(mocks.runBackfill).toHaveBeenCalled());
        expect(mocks.isLockHeld).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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

  // Dev escape hatch: TICKR_DISABLE_REMOTE_JOBS=1 skips every job that reaches the
  // external data APIs (backfill, intraday sweep, universe refresh) while leaving
  // the DB/Redis-only alerts job running. deploy.sh refuses the flag in prod.
  describe('TICKR_DISABLE_REMOTE_JOBS=1', () => {
    const prev = process.env['TICKR_DISABLE_REMOTE_JOBS'];
    beforeEach(() => {
      process.env['TICKR_DISABLE_REMOTE_JOBS'] = '1';
    });
    afterEach(() => {
      if (prev === undefined) delete process.env['TICKR_DISABLE_REMOTE_JOBS'];
      else process.env['TICKR_DISABLE_REMOTE_JOBS'] = prev;
    });

    it('registers only the alerts cron and skips the external-data schedules', () => {
      registerScheduledJobs(fakeRedis);

      // Both intraday and alerts use '0 */5 * * * *'; with remote jobs off only
      // the alerts firing remains, so exactly one cron is registered.
      expect(mocks.schedule).toHaveBeenCalledTimes(1);
      expect(mocks.schedule.mock.calls[0]?.[0]).toBe('0 */5 * * * *');
    });

    it('does not run the startup backfill or touch the Massive locks', () => {
      registerScheduledJobs(fakeRedis);

      expect(mocks.runBackfill).not.toHaveBeenCalled();
      expect(acquiredKeys()).not.toContain(BACKFILL_LOCK);
    });

    it('still fires the alerts check on its cron', async () => {
      registerScheduledJobs(fakeRedis);
      callbackFor('0 */5 * * * *')();

      await vi.waitFor(() => expect(mocks.runAlertCheck).toHaveBeenCalled());
      expect(mocks.runIntradayUpdate).not.toHaveBeenCalled();
    });
  });
});
