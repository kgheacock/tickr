import type { Redis } from 'ioredis';
import type { JobStatus } from '@tickr/shared-types';

/**
 * Per-job run status (the admin `/admin/jobs` viewer, parallel to `/admin/logs`).
 *
 * Scheduled jobs run in the *worker* process but the status is read by the *api*
 * process's `GET /admin/ops`, so — like `metrics/redis.ts` — it must live in
 * shared Redis, not an in-process map. Each job gets one hash recording its last
 * actual execution (start/finish/outcome/duration/error) plus lifetime
 * run/fail/skip counters, and a short-lived "running" marker with a TTL crash-net
 * so a crashed worker doesn't read as forever-running.
 *
 * Recording is funnelled through the scheduler's `withLock` seam (plus a direct
 * wrap for the lock-less alert check), so every job is instrumented in one place
 * rather than at 13 call sites.
 */

/**
 * Canonical Redis lock keys, defined once here so the scheduler and this status
 * layer can't drift. `null` = the job holds no lock (only the alert check).
 */
export const JOB_LOCKS = {
  backfill: 'massive:job:backfill',
  sessionUpdate: 'massive:job:session-update',
  universeRefresh: 'massive:job:universe-refresh',
  closeCapture: 'finnhub:job:close-capture',
  classify: 'fs:job:classify',
  lineupLock: 'fs:job:lineup-lock',
  scoring: 'fs:job:scoring',
  waivers: 'fs:job:waivers',
  lineupReminder: 'fs:job:lineup-reminder',
} as const;

export interface JobDef {
  /** Stable status key — kebab-case, never the lock key (two jobs share a lock). */
  name: string;
  /** Redis lock key this job runs under, or null if it takes no lock. */
  lockKey: string | null;
  /** Cron expression(s), for reference (node-cron gives no next-run, so we show the rule). */
  cron: string;
  /** Human-readable cadence. */
  cadence: string;
  /** What the job does. */
  description: string;
  /**
   * True for jobs that reach an external data API (Massive/Finnhub/Wikipedia) —
   * these are skipped entirely under TICKR_DISABLE_REMOTE_JOBS, so a "never ran"
   * status in dev is expected, not a fault.
   */
  remote: boolean;
}

/**
 * The static job registry — the single source of truth for what jobs exist and
 * how they're scheduled. Static (not derived from what got `cron.schedule`d) so a
 * remote job still lists here, as "never run", under TICKR_DISABLE_REMOTE_JOBS.
 * Note SESSION_UPDATE_LOCK and SCORING_LOCK each back two distinct jobs — they
 * are tracked by `name`, never by lock key.
 */
export const JOB_DEFS = [
  {
    name: 'backfill',
    lockKey: JOB_LOCKS.backfill,
    cron: '0 0 * * * *',
    cadence: 'Hourly · off-hours only',
    description: 'Hydrate ~2yr price history for not-yet-backfilled symbols',
    remote: true,
  },
  {
    name: 'intraday-sweep',
    lockKey: JOB_LOCKS.sessionUpdate,
    cron: '0 */5 * * * *',
    cadence: 'Every 5 min · market hours',
    description: 'Append the live price tail across the playable corpus',
    remote: true,
  },
  {
    name: 'saturday-catchup',
    lockKey: JOB_LOCKS.sessionUpdate,
    cron: '0 30 13 * * 6',
    cadence: 'Sat 13:30 UTC',
    description: "Pull Friday's now-available bars forward before Monday",
    remote: true,
  },
  {
    name: 'universe-refresh',
    lockKey: JOB_LOCKS.universeRefresh,
    cron: '0 0 0 * * 1,3,6',
    cadence: 'Mon/Wed/Sat 00:00 UTC',
    description: 'Refresh the S&P 500 universe, then metadata + branding',
    remote: true,
  },
  {
    name: 'close-capture',
    lockKey: JOB_LOCKS.closeCapture,
    cron: '0 30 21 * * 5',
    cadence: 'Fri 21:30 UTC',
    description: "Capture Friday's close via Finnhub for the FS weekly settle",
    remote: true,
  },
  {
    name: 'alert-check',
    lockKey: null,
    cron: '0 */5 * * * *',
    cadence: 'Every 5 min',
    description: 'Check stuck states (EOD lag, backfill, 429 burst) and alert',
    remote: false,
  },
  {
    name: 'classifier',
    lockKey: JOB_LOCKS.classify,
    cron: '0 0 6 * * 0',
    cadence: 'Sun 06:00 UTC',
    description: 'Recompute Fantasy Street player classifications',
    remote: false,
  },
  {
    name: 'lineup-lock',
    lockKey: JOB_LOCKS.lineupLock,
    cron: '0 30 14 * * 1-5',
    cadence: "Market open · week's first trading day",
    description: 'Freeze active-league lineups and auto-fill gaps',
    remote: false,
  },
  {
    name: 'lineup-reminders',
    lockKey: JOB_LOCKS.lineupReminder,
    cron: '0 0 18 * * 0 · 0 0 13 * * 1-5',
    cadence: 'Sun 18:00 + weekday 13:00 UTC',
    description: 'Nudge managers whose scoring-week lineup is still incomplete',
    remote: false,
  },
  {
    name: 'weekly-settle',
    lockKey: JOB_LOCKS.scoring,
    cron: '0 35 21 * * 5',
    cadence: 'Fri 21:35 UTC',
    description: 'Settle the scoring week and close out the season',
    remote: false,
  },
  {
    name: 'provisional-scoring',
    lockKey: JOB_LOCKS.scoring,
    cron: '0 35 21 * * 1-4',
    cadence: 'Mon–Thu 21:35 UTC',
    description: 'Push best-effort in-week provisional scores (not persisted)',
    remote: false,
  },
  {
    name: 'waivers',
    lockKey: JOB_LOCKS.waivers,
    cron: '0 45 21 * * 5',
    cadence: 'Fri 21:45 UTC',
    description: 'Resolve queued add/drop waiver claims for settled leagues',
    remote: false,
  },
] as const satisfies readonly JobDef[];

/**
 * The set of valid job names, derived from the registry. Typing the recording
 * functions with this makes a typo'd call-site name a compile error rather than a
 * job that silently reads "never ran" forever.
 */
export type JobName = (typeof JOB_DEFS)[number]['name'];

// Default TTL for the "running" crash-net marker when a caller doesn't pass the
// job's own lock TTL. 30 min matches the scheduler's default lock TTL.
const DEFAULT_RUNNING_TTL_MS = 30 * 60 * 1000;
// Cap a stored error so a giant stack can't bloat the hash / the ops payload.
const MAX_ERROR_LEN = 1000;

const hashKey = (name: string): string => `metrics:job:${name}`;
const runningKey = (name: string): string => `metrics:job:${name}:running`;

/** Mark a job as started: stamp the start time and set the running crash-net. */
export async function recordJobStart(
  redis: Redis,
  name: JobName,
  ttlMs: number = DEFAULT_RUNNING_TTL_MS,
): Promise<void> {
  const now = new Date().toISOString();
  await redis.hset(hashKey(name), 'lastStartAt', now);
  await redis.set(runningKey(name), now, 'PX', ttlMs);
}

/**
 * Record the result of a job that actually ran. Updates the last-execution
 * fields and the run/fail counters, and clears the running marker. `lastOutcome`
 * only ever reflects a real execution (ok|error) — a busy-skip never overwrites
 * it (see recordJobSkip).
 */
export async function recordJobResult(
  redis: Redis,
  name: JobName,
  result: { ok: boolean; durationMs: number; error?: string },
): Promise<void> {
  const pipe = redis.pipeline();
  pipe.hset(hashKey(name), {
    lastFinishAt: new Date().toISOString(),
    lastOutcome: result.ok ? 'ok' : 'error',
    lastDurationMs: String(Math.max(0, Math.round(result.durationMs))),
    // Clear any prior error on success so the viewer never pairs a green run
    // with a stale failure message.
    lastError: result.ok ? '' : (result.error ?? '').slice(0, MAX_ERROR_LEN),
  });
  pipe.hincrby(hashKey(name), 'runs', 1);
  if (!result.ok) pipe.hincrby(hashKey(name), 'fails', 1);
  pipe.del(runningKey(name));
  await pipe.exec();
}

/**
 * Record that a firing was skipped because the prior run still held the lock.
 * Deliberately does NOT touch lastOutcome/lastStartAt — for a job like the
 * intraday sweep most firings are expected skips, and they must not mask the
 * last real run.
 */
export async function recordJobSkip(
  redis: Redis,
  name: JobName,
): Promise<void> {
  const pipe = redis.pipeline();
  pipe.hset(hashKey(name), 'lastSkipAt', new Date().toISOString());
  pipe.hincrby(hashKey(name), 'skips', 1);
  await pipe.exec();
}

function toStatus(
  def: JobDef,
  hash: Record<string, string>,
  running: boolean,
): JobStatus {
  const num = (v: string | undefined): number | null =>
    v === undefined || v === '' ? null : Number(v);
  const str = (v: string | undefined): string | null =>
    v === undefined || v === '' ? null : v;
  return {
    name: def.name,
    cadence: def.cadence,
    cron: def.cron,
    description: def.description,
    remote: def.remote,
    running,
    lastStartAt: str(hash['lastStartAt']),
    lastFinishAt: str(hash['lastFinishAt']),
    lastOutcome: (str(hash['lastOutcome']) as JobStatus['lastOutcome']) ?? null,
    lastDurationMs: num(hash['lastDurationMs']),
    lastError: str(hash['lastError']),
    lastSkipAt: str(hash['lastSkipAt']),
    runs: num(hash['runs']) ?? 0,
    fails: num(hash['fails']) ?? 0,
    skips: num(hash['skips']) ?? 0,
  };
}

/**
 * Read every registered job's status, merged with its static definition. One
 * pipeline (HGETALL + EXISTS per job) keeps it to a single round trip. Always
 * returns one entry per JOB_DEFS in registry order, even for jobs that never ran.
 */
export async function readJobStatuses(redis: Redis): Promise<JobStatus[]> {
  const pipe = redis.pipeline();
  for (const def of JOB_DEFS) {
    pipe.hgetall(hashKey(def.name));
    pipe.exists(runningKey(def.name));
  }
  const results = await pipe.exec();

  return JOB_DEFS.map((def, i) => {
    // Each job contributes two pipeline replies: [err, value] tuples.
    const hash = (results?.[i * 2]?.[1] as Record<string, string>) ?? {};
    const running = (results?.[i * 2 + 1]?.[1] as number) === 1;
    return toStatus(def, hash, running);
  });
}
