import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Redis } from 'ioredis';

// Capture cron registrations and stub out everything the scheduler touches so the
// test asserts the *schedule definition* (cron expressions, ordering, locking)
// without a Redis or Postgres dependency. vi.hoisted keeps the mock fns available
// inside the hoisted vi.mock factories.
const mocks = vi.hoisted(() => ({
  schedule: vi.fn(),
  runBackfill: vi.fn(),
  runIntradayUpdate: vi.fn(),
  runMetadataRefresh: vi.fn(),
  seedUniverse: vi.fn(),
  runAlertCheck: vi.fn(),
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
vi.mock('../../src/jobs/locks.js', () => ({
  tryAcquireLock: mocks.tryAcquireLock,
  releaseLock: mocks.releaseLock,
}));

import { registerScheduledJobs } from '../../src/jobs/scheduler.js';

const BACKFILL_LOCK = 'massive:job:backfill';
const UNIVERSE_REFRESH_LOCK = 'massive:job:universe-refresh';
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

const fakeRedis = {} as unknown as Redis;

/** Find the callback registered for a given cron expression. */
function callbackFor(expr: string): () => void {
  const call = mocks.schedule.mock.calls.find((c) => c[0] === expr);
  if (!call) throw new Error(`no cron registered for "${expr}"`);
  return call[1] as () => void;
}

describe('registerScheduledJobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: the firing wins the lock so the wrapped job actually runs.
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
  });

  it('registers exactly the expected cron schedules', () => {
    registerScheduledJobs(fakeRedis);

    const exprs = mocks.schedule.mock.calls.map((c) => c[0]);
    expect(exprs).toContain('0 0 * * * *'); // hourly backfill
    expect(exprs).toContain('0 0 0 * * 1,3,6'); // universe refresh: Mon/Wed/Sat 00:00 UTC
    expect(exprs).toContain('0 30 21 * * 1-5'); // session update (weekday close)
    expect(exprs).toContain('0 */5 * * * *'); // alerts
    // Fantasy Street jobs (FS-02/04/05/07).
    expect(exprs).toContain('0 0 6 * * 0'); // classifier: Sunday 06:00 UTC
    expect(exprs).toContain('0 30 14 * * 1-5'); // lineup lock: weekday open
    expect(exprs).toContain('0 35 21 * * 5'); // weekly settle: Friday close
    expect(exprs).toContain('0 35 21 * * 1-4'); // provisional scoring: Mon–Thu
    expect(exprs).toContain('0 45 21 * * 5'); // waiver run: Friday post-settle
    expect(mocks.schedule).toHaveBeenCalledTimes(9);
  });

  it('runs the startup backfill under the backfill lock with the long TTL', () => {
    registerScheduledJobs(fakeRedis);

    // The startup catch-up fires immediately (not via cron).
    expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
      fakeRedis,
      BACKFILL_LOCK,
      SIX_HOURS_MS,
    );
  });

  it('hourly backfill acquires the backfill lock with the long TTL', async () => {
    registerScheduledJobs(fakeRedis);

    callbackFor('0 0 * * * *')();

    // Both the startup and hourly firings use the same key + long TTL, so assert
    // on the args rather than the call count (the startup firing is async and
    // would make a strict count flaky).
    await vi.waitFor(() =>
      expect(mocks.tryAcquireLock).toHaveBeenCalledWith(
        fakeRedis,
        BACKFILL_LOCK,
        SIX_HOURS_MS,
      ),
    );
    await vi.waitFor(() => expect(mocks.runBackfill).toHaveBeenCalled());
  });

  it('universe refresh reconciles then refreshes metadata, in that order, under its own lock', async () => {
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

  it('skips a firing when the lock is already held', async () => {
    mocks.tryAcquireLock.mockResolvedValue(null); // someone else holds it

    registerScheduledJobs(fakeRedis);
    callbackFor('0 0 0 * * 1,3,6')();

    // Give the fire-and-forget promise a tick to settle.
    await Promise.resolve();
    expect(mocks.seedUniverse).not.toHaveBeenCalled();
    expect(mocks.runMetadataRefresh).not.toHaveBeenCalled();
  });
});
