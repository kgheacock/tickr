/**
 * Fantasy Street item 03 — the pick clock (the thin, side-effecting shell).
 *
 * Per-pick timing is sub-cron granularity, so the clock is a Redis-backed
 * deadline (`fs:draft:{id}:deadline`) advanced by an in-process timer running in
 * the `api` role (armed from roles/api.ts). All the draft *logic* lives in the
 * pure functions in draft.ts; this module only schedules timers, writes the
 * deadline, and broadcasts over WS. On expiry it auto-picks for the manager on
 * the clock and re-arms for the next seat.
 *
 * Single-instance assumption: the timer lives only on the api instance that
 * armed it (the same instance handling the start/pick request). A Redis tick
 * lock keyed by overall pick keeps a stray second instance from double-picking,
 * but durable multi-instance fail-over is out of scope for FS-03.
 */
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { getDraftState, autoPickOnClock, type PickResult } from './draft.js';
import { generateSchedule } from './schedule.js';
import { ensureSeason } from './season.js';
import { isBotMember } from './bots.js';
import { tryAcquireLock } from '../jobs/locks.js';
import {
  publishDraftPick,
  publishDraftOnClock,
  publishDraftComplete,
} from '../events/publisher.js';

const GRACE_MS = 5_000;

/**
 * The clock window for the seat about to be put on the clock. A human gets the
 * full `pickSeconds`; an auto-manager (FS-10) gets 0 — its auto-pick fires
 * immediately on the next tick instead of holding up the draft (DoD: bots pick
 * instantly without holding the clock). Pure so the decision is unit-testable
 * without standing up Redis/timers.
 */
export function pickWindowMs(isBot: boolean, pickSeconds: number): number {
  return isBot ? 0 : pickSeconds * 1000;
}

export interface DraftClock {
  /** Put the current seat on the clock; `announce` emits a draft.onClock. */
  arm(
    leagueId: string,
    announce: boolean,
  ): Promise<{ deadline: string } | null>;
  /** Auto/manual pick landed elsewhere — broadcast it and advance the clock. */
  broadcastPick(leagueId: string, result: PickResult): Promise<void>;
  /** Stop the timer for a league (draft over or cancelled). */
  cancel(leagueId: string): void;
  /** Tear down every timer (process shutdown). */
  close(): void;
}

export function createDraftClock(pool: Pool, redis: Redis): DraftClock {
  const timers = new Map<string, NodeJS.Timeout>();

  function cancel(leagueId: string): void {
    const t = timers.get(leagueId);
    if (t) {
      clearTimeout(t);
      timers.delete(leagueId);
    }
  }

  function schedule(leagueId: string, ms: number): void {
    cancel(leagueId);
    const t = setTimeout(() => {
      timers.delete(leagueId);
      void onExpiry(leagueId).catch((err: unknown) => {
        console.error(
          JSON.stringify({
            level: 'error',
            component: 'draft-clock',
            msg: 'auto-pick on expiry failed',
            leagueId,
            err: String(err),
          }),
        );
      });
    }, ms);
    t.unref?.();
    timers.set(leagueId, t);
  }

  async function arm(
    leagueId: string,
    announce: boolean,
  ): Promise<{ deadline: string } | null> {
    const state = await getDraftState(pool, leagueId);
    if (!state || state.status !== 'in_progress' || !state.onClockUserId) {
      cancel(leagueId);
      return null;
    }
    // A bot on the clock picks immediately (window 0); a human gets the timer.
    const isBot = await isBotMember(pool, leagueId, state.onClockUserId);
    const windowMs = pickWindowMs(isBot, state.pickSeconds);
    const deadlineMs = Date.now() + windowMs;
    const deadline = new Date(deadlineMs).toISOString();
    await redis.set(
      `fs:draft:${state.id}:deadline`,
      String(deadlineMs),
      'PX',
      windowMs + GRACE_MS,
    );
    schedule(leagueId, windowMs);
    if (announce) {
      await publishDraftOnClock(
        redis,
        leagueId,
        state.currentOverallPick,
        state.onClockUserId,
        deadline,
      );
    }
    return { deadline };
  }

  async function broadcastPick(
    leagueId: string,
    result: PickResult,
  ): Promise<void> {
    if (result.completed) {
      await publishDraftPick(
        redis,
        leagueId,
        result.pick,
        result.state.currentOverallPick,
        null,
        null,
      );
      await publishDraftComplete(redis, leagueId, result.state.id);
      // FS-06/08: the draft just flipped the league to `active` (draft.ts).
      // Open/activate the season row (FS-08) first so the schedule's matchups
      // can resolve their season_id FK, then generate the head-to-head schedule
      // for that season — both in-process and idempotent, not off a Redis echo.
      // broadcastPick runs post-commit, so the managers, season length, and
      // (after a re-draft) the latest season number are durably readable here.
      const season = await ensureSeason(pool, leagueId);
      await generateSchedule(pool, leagueId, season.season_number);
      cancel(leagueId);
      return;
    }
    const armed = await arm(leagueId, false);
    await publishDraftPick(
      redis,
      leagueId,
      result.pick,
      result.state.currentOverallPick,
      result.state.onClockUserId,
      armed?.deadline ?? null,
    );
  }

  async function onExpiry(leagueId: string): Promise<void> {
    const state = await getDraftState(pool, leagueId);
    if (!state || state.status !== 'in_progress') return;
    const expectedPick = state.currentOverallPick;
    // Dedupe across instances: only one tick per overall pick proceeds. The
    // lock is intentionally not released — it expires on its own TTL.
    const owner = await tryAcquireLock(
      redis,
      `fs:draft:${state.id}:tick:${expectedPick}`,
      10_000,
    );
    if (!owner) return;
    // Bind to the seat the clock fired for: if a manual pick advanced the clock
    // while we waited, autoPickOnClock returns null rather than skipping a turn.
    const result = await autoPickOnClock(pool, leagueId, expectedPick);
    if (result) await broadcastPick(leagueId, result);
  }

  return {
    arm,
    broadcastPick,
    cancel,
    close(): void {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
