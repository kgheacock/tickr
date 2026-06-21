import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import {
  JOB_DEFS,
  JOB_LOCKS,
  recordJobStart,
  recordJobResult,
  recordJobSkip,
  readJobStatuses,
} from '../../src/jobs/status.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redis = new Redis(REDIS_URL);

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

const find = (
  jobs: Awaited<ReturnType<typeof readJobStatuses>>,
  name: string,
) => jobs.find((j) => j.name === name)!;

describe('job status registry', () => {
  it('every lockKey is null or a known JOB_LOCKS value, and names are unique', () => {
    const lockValues = new Set<string>(Object.values(JOB_LOCKS));
    const names = new Set<string>();
    for (const def of JOB_DEFS) {
      if (def.lockKey !== null) expect(lockValues.has(def.lockKey)).toBe(true);
      expect(names.has(def.name)).toBe(false);
      names.add(def.name);
    }
    expect(names.size).toBe(JOB_DEFS.length);
  });

  it('weekly-settle runs under the scoring lock', () => {
    const settle = JOB_DEFS.find((d) => d.name === 'weekly-settle')!;
    expect(settle.lockKey).toBe(JOB_LOCKS.scoring);
  });

  it('does not register the removed saturday-catchup / provisional-scoring jobs', () => {
    const names = JOB_DEFS.map((d) => d.name);
    expect(names).not.toContain('saturday-catchup');
    expect(names).not.toContain('provisional-scoring');
  });
});

describe('readJobStatuses', () => {
  it('returns one entry per registry job, in order, even with no recorded runs', async () => {
    const jobs = await readJobStatuses(redis);
    expect(jobs.map((j) => j.name)).toEqual(JOB_DEFS.map((d) => d.name));
    for (const j of jobs) {
      expect(j.running).toBe(false);
      expect(j.lastOutcome).toBeNull();
      expect(j.lastStartAt).toBeNull();
      expect(j.runs).toBe(0);
      expect(j.fails).toBe(0);
      expect(j.skips).toBe(0);
    }
  });
});

describe('record → read round trip', () => {
  it('records a successful run: ok outcome, duration, run count, not running', async () => {
    await recordJobStart(redis, 'lineup-lock');
    await recordJobResult(redis, 'lineup-lock', { ok: true, durationMs: 1234 });

    const job = find(await readJobStatuses(redis), 'lineup-lock');
    expect(job.running).toBe(false);
    expect(job.lastOutcome).toBe('ok');
    expect(job.lastDurationMs).toBe(1234);
    expect(job.lastStartAt).not.toBeNull();
    expect(job.lastFinishAt).not.toBeNull();
    expect(job.lastError).toBeNull();
    expect(job.runs).toBe(1);
    expect(job.fails).toBe(0);
  });

  it('records a failed run: error outcome, message, fail count', async () => {
    await recordJobStart(redis, 'waivers');
    await recordJobResult(redis, 'waivers', {
      ok: false,
      durationMs: 50,
      error: 'boom: something broke',
    });

    const job = find(await readJobStatuses(redis), 'waivers');
    expect(job.lastOutcome).toBe('error');
    expect(job.lastError).toBe('boom: something broke');
    expect(job.runs).toBe(1);
    expect(job.fails).toBe(1);
  });

  it('clears a prior error message once a later run succeeds', async () => {
    await recordJobResult(redis, 'waivers', {
      ok: false,
      durationMs: 10,
      error: 'first failure',
    });
    await recordJobResult(redis, 'waivers', { ok: true, durationMs: 20 });

    const job = find(await readJobStatuses(redis), 'waivers');
    expect(job.lastOutcome).toBe('ok');
    expect(job.lastError).toBeNull();
    expect(job.runs).toBe(2);
    expect(job.fails).toBe(1);
  });

  it('marks a job running between start and result', async () => {
    await recordJobStart(redis, 'intraday-sweep');

    const running = find(await readJobStatuses(redis), 'intraday-sweep');
    expect(running.running).toBe(true);
    expect(running.lastStartAt).not.toBeNull();
    expect(running.lastOutcome).toBeNull(); // hasn't finished yet

    await recordJobResult(redis, 'intraday-sweep', {
      ok: true,
      durationMs: 99,
    });
    const done = find(await readJobStatuses(redis), 'intraday-sweep');
    expect(done.running).toBe(false);
  });

  it('a busy-skip increments skips without touching the last real outcome', async () => {
    await recordJobResult(redis, 'intraday-sweep', {
      ok: true,
      durationMs: 100,
    });
    await recordJobSkip(redis, 'intraday-sweep');
    await recordJobSkip(redis, 'intraday-sweep');

    const job = find(await readJobStatuses(redis), 'intraday-sweep');
    expect(job.skips).toBe(2);
    expect(job.lastSkipAt).not.toBeNull();
    expect(job.lastOutcome).toBe('ok'); // unchanged by skips
    expect(job.runs).toBe(1);
  });

  it('truncates a very long error to keep the payload bounded', async () => {
    const huge = 'x'.repeat(5000);
    await recordJobResult(redis, 'backfill', {
      ok: false,
      durationMs: 1,
      error: huge,
    });
    const job = find(await readJobStatuses(redis), 'backfill');
    expect(job.lastError!.length).toBeLessThanOrEqual(1000);
  });
});
