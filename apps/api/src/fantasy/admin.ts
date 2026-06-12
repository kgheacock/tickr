/**
 * Fantasy Street item 12 — commissioner & admin operations.
 *
 * The privileged mid-season controls a commissioner needs to keep a league
 * running, layered on the existing pipeline rather than editing results by hand:
 *   - mid-season settings  — change the safe subset (name, join policy); reject
 *                            structural edits (size, roster) once the draft starts.
 *   - member management    — remove a pre-draft member, rename a team, transfer
 *                            the commissioner role.
 *   - dispute re-score     — re-run FS-05 scoring for a week (idempotent upsert),
 *                            which re-settles FS-06 matchups and re-ranks standings.
 *   - force-advance        — settle/close a stuck week and drive the FS-08 season
 *                            transition off whatever scores exist.
 *   - lineup override      — set or unlock a manager's lineup in exceptional cases.
 *
 * Every mutation writes an fs_audit_log row (audit.ts): direct mutations enlist
 * the audit in their own transaction; the pipeline actions (re-score / advance,
 * which call settle.ts on its own connection) audit after the settle succeeds.
 * Authorization is the route guard's job (requireCommissioner); these re-assert
 * it at the domain layer too, the same way leagues.ts does, so the rules are
 * exercised without Redis. See test/fantasy/commissioner.test.ts.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  JoinPolicy,
  RosterConfig,
  LeagueView,
  Lineup,
  WeeklyScore,
  FantasyHealth,
  LeagueStatus,
} from '@tickr/shared-types';
import {
  FantasyError,
  assertCommissioner,
  getLeagueView,
  validateRosterConfig,
} from './leagues.js';
import { writeAudit } from './audit.js';
import { settleLeagueWeek } from './score.js';
import { settleMatchups, type SettleResult } from './settle.js';
import { generateLeagueRecaps } from './recap.js';
import { ensureLineupRow, setLineup, getLineup } from './lineup.js';
import { nyseRegularCloseAnchor, currentFriday } from '../market/holidays.js';
import type { Redis } from 'ioredis';

const DAY_MS = 24 * 60 * 60 * 1000;

// --- Internal helpers -------------------------------------------------------

interface LeagueRow {
  status: LeagueStatus;
  commissioner_user_id: string;
  size: number;
}

async function loadLeague(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<LeagueRow> {
  const { rows } = await db.query<LeagueRow>(
    `SELECT status, commissioner_user_id, size FROM fs_league WHERE id = $1`,
    [leagueId],
  );
  if (!rows[0])
    throw new FantasyError('NOT_FOUND', `League not found: ${leagueId}`);
  return rows[0];
}

async function memberRole(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
): Promise<'commissioner' | 'manager' | null> {
  const { rows } = await db.query<{ role: 'commissioner' | 'manager' }>(
    `SELECT role FROM fs_league_member WHERE league_id = $1 AND user_id = $2`,
    [leagueId, userId],
  );
  return rows[0]?.role ?? null;
}

async function isBot(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM fs_bot_member WHERE league_id = $1 AND user_id = $2`,
    [leagueId, userId],
  );
  return rows.length > 0;
}

function assertWeek(week: number): void {
  if (!Number.isInteger(week) || week < 1) {
    throw new FantasyError('VALIDATION', 'week must be a positive integer');
  }
}

// --- Mid-season settings ----------------------------------------------------

export interface MidSeasonSettingsInput {
  name?: string | undefined;
  joinPolicy?: JoinPolicy | undefined;
  size?: number | undefined;
  seasonLengthWeeks?: number | undefined;
  rosterConfig?: RosterConfig | undefined;
}

const STRUCTURAL_FIELDS = [
  'size',
  'seasonLengthWeeks',
  'rosterConfig',
] as const;

/**
 * Edit a league's settings mid-season. The safe subset (name, join policy) may
 * change in any non-archived status; structural settings (size, season length,
 * roster config) are locked once the draft has started (status past `forming`)
 * and require the FS-08 season-reset path instead.
 */
export async function updateMidSeasonSettings(
  pool: Pool,
  leagueId: string,
  input: MidSeasonSettingsInput,
  actorUserId: string,
): Promise<LeagueView> {
  await assertCommissioner(pool, leagueId, actorUserId);
  const league = await loadLeague(pool, leagueId);
  if (league.status === 'archived') {
    throw new FantasyError('CONFLICT', 'League is archived and read-only');
  }

  const touchesStructural = STRUCTURAL_FIELDS.some(
    (f) => input[f] !== undefined,
  );
  if (touchesStructural && league.status !== 'forming') {
    throw new FantasyError(
      'CONFLICT',
      'Structural settings are locked once the draft has started',
    );
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const changed: string[] = [];
  const set = (col: string, field: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
    changed.push(field);
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new FantasyError('VALIDATION', 'name must not be empty');
    set('name', 'name', name);
  }
  if (input.joinPolicy !== undefined) {
    if (input.joinPolicy !== 'invite' && input.joinPolicy !== 'open') {
      throw new FantasyError(
        'VALIDATION',
        "joinPolicy must be 'invite' or 'open'",
      );
    }
    set('join_policy', 'joinPolicy', input.joinPolicy);
  }
  if (input.size !== undefined) {
    if (!Number.isInteger(input.size) || input.size < 4 || input.size > 12) {
      throw new FantasyError('VALIDATION', 'size must be an integer 4–12');
    }
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM fs_league_member WHERE league_id = $1`,
      [leagueId],
    );
    if (input.size < Number(rows[0]!.count)) {
      throw new FantasyError(
        'CONFLICT',
        'size cannot be below current member count',
      );
    }
    set('size', 'size', input.size);
  }
  if (input.seasonLengthWeeks !== undefined) {
    if (
      !Number.isInteger(input.seasonLengthWeeks) ||
      input.seasonLengthWeeks < 1
    ) {
      throw new FantasyError(
        'VALIDATION',
        'seasonLengthWeeks must be a positive integer',
      );
    }
    set('season_length_weeks', 'seasonLengthWeeks', input.seasonLengthWeeks);
  }
  if (input.rosterConfig !== undefined) {
    validateRosterConfig(input.rosterConfig);
    set('roster_config', 'rosterConfig', JSON.stringify(input.rosterConfig));
  }

  if (sets.length === 0) {
    throw new FantasyError('VALIDATION', 'no settings to update');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    params.push(leagueId);
    await client.query(
      `UPDATE fs_league SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
    await writeAudit(client, {
      leagueId,
      actorUserId,
      action: 'settings.update',
      detail: { changed, status: league.status },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getLeagueView(leagueId, actorUserId, pool);
}

// --- Member management ------------------------------------------------------

/**
 * Remove a member before the draft starts (replace them with a bot via FS-10 if
 * the league still needs a full field). Only valid while `forming`; the
 * commissioner cannot remove themselves (transfer the role first). Also clears a
 * bot flag so a removed bot leaves nothing dangling.
 */
export async function removeMember(
  pool: Pool,
  leagueId: string,
  targetUserId: string,
  actorUserId: string,
): Promise<LeagueView> {
  await assertCommissioner(pool, leagueId, actorUserId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lg } = await client.query<LeagueRow>(
      `SELECT status, commissioner_user_id, size
         FROM fs_league WHERE id = $1 FOR UPDATE`,
      [leagueId],
    );
    if (!lg[0])
      throw new FantasyError('NOT_FOUND', `League not found: ${leagueId}`);
    if (lg[0].status !== 'forming') {
      throw new FantasyError(
        'CONFLICT',
        'Members can only be removed before the draft starts',
      );
    }
    const role = await memberRole(client, leagueId, targetUserId);
    if (role === null) {
      throw new FantasyError(
        'NOT_FOUND',
        'User is not a member of this league',
      );
    }
    if (role === 'commissioner') {
      throw new FantasyError(
        'CONFLICT',
        'Cannot remove the commissioner; transfer the role first',
      );
    }
    await client.query(
      `DELETE FROM fs_bot_member WHERE league_id = $1 AND user_id = $2`,
      [leagueId, targetUserId],
    );
    await client.query(
      `DELETE FROM fs_league_member WHERE league_id = $1 AND user_id = $2`,
      [leagueId, targetUserId],
    );
    await writeAudit(client, {
      leagueId,
      actorUserId,
      action: 'member.remove',
      detail: { targetUserId },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getLeagueView(leagueId, actorUserId, pool);
}

/** Set a member's team name (commissioner editing any team). */
export async function renameTeam(
  pool: Pool,
  leagueId: string,
  targetUserId: string,
  teamName: string,
  actorUserId: string,
): Promise<LeagueView> {
  await assertCommissioner(pool, leagueId, actorUserId);
  const name = teamName.trim();
  if (!name) throw new FantasyError('VALIDATION', 'teamName must not be empty');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE fs_league_member SET team_name = $3
        WHERE league_id = $1 AND user_id = $2`,
      [leagueId, targetUserId, name],
    );
    if (!rowCount) {
      throw new FantasyError(
        'NOT_FOUND',
        'User is not a member of this league',
      );
    }
    await writeAudit(client, {
      leagueId,
      actorUserId,
      action: 'member.rename',
      detail: { targetUserId, teamName: name },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getLeagueView(leagueId, actorUserId, pool);
}

/**
 * Transfer the commissioner role to another (human) member. The current
 * commissioner is demoted to manager; the target is promoted and recorded as the
 * league's commissioner. A bot cannot hold the role.
 */
export async function transferCommissioner(
  pool: Pool,
  leagueId: string,
  targetUserId: string,
  actorUserId: string,
): Promise<LeagueView> {
  await assertCommissioner(pool, leagueId, actorUserId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: lg } = await client.query<{ commissioner_user_id: string }>(
      `SELECT commissioner_user_id FROM fs_league WHERE id = $1 FOR UPDATE`,
      [leagueId],
    );
    if (!lg[0])
      throw new FantasyError('NOT_FOUND', `League not found: ${leagueId}`);
    if (targetUserId === lg[0].commissioner_user_id) {
      throw new FantasyError('CONFLICT', 'User is already the commissioner');
    }
    if ((await memberRole(client, leagueId, targetUserId)) === null) {
      throw new FantasyError(
        'NOT_FOUND',
        'User is not a member of this league',
      );
    }
    if (await isBot(client, leagueId, targetUserId)) {
      throw new FantasyError(
        'CONFLICT',
        'Cannot transfer the role to an auto-manager',
      );
    }
    await client.query(
      `UPDATE fs_league_member SET role = 'manager'
        WHERE league_id = $1 AND role = 'commissioner'`,
      [leagueId],
    );
    await client.query(
      `UPDATE fs_league_member SET role = 'commissioner'
        WHERE league_id = $1 AND user_id = $2`,
      [leagueId, targetUserId],
    );
    await client.query(
      `UPDATE fs_league SET commissioner_user_id = $2 WHERE id = $1`,
      [leagueId, targetUserId],
    );
    await writeAudit(client, {
      leagueId,
      actorUserId,
      action: 'member.transfer',
      detail: { from: actorUserId, to: targetUserId },
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getLeagueView(leagueId, targetUserId, pool);
}

// --- Dispute re-score -------------------------------------------------------

export interface RescoreOptions {
  reason?: string | undefined;
  season?: number | undefined;
  /** The scoring week's Friday close anchor; defaults to the live-week anchor. */
  weekEnd?: Date | undefined;
  /** Prior-week close anchor; defaults to the live-week baseline. */
  baselineAt?: Date | undefined;
  /** Wall clock for deriving the default anchors (tests pin this). */
  now?: Date | undefined;
}

export interface RescoreResult {
  season: number;
  week: number;
  scores: WeeklyScore[];
  settle: SettleResult;
}

/**
 * Resolve a dispute by re-running the week's scoring through the normal pipeline.
 * settleLeagueWeek recomputes each manager's score and upserts it (idempotent);
 * settleMatchups then re-settles the head-to-heads and rebuilds standings off
 * those fresh totals. The anchors default to mirror the scheduler's live-week
 * inputs exactly (`nyseRegularCloseAnchor(currentFriday(now))` and the matching
 * −7d baseline) so a re-score of the live week reproduces identical scores; a
 * historical dispute can pass explicit anchors. The commissioner and their
 * reason are recorded after the settle succeeds.
 */
export async function rescoreWeek(
  pool: Pool,
  leagueId: string,
  week: number,
  actorUserId: string,
  opts: RescoreOptions = {},
  redis?: Redis,
): Promise<RescoreResult> {
  await assertCommissioner(pool, leagueId, actorUserId);
  assertWeek(week);
  const season = opts.season ?? 1;

  const now = opts.now ?? new Date();
  const friday = currentFriday(now);
  const weekEnd = opts.weekEnd ?? nyseRegularCloseAnchor(friday);
  const baselineAt =
    opts.baselineAt ??
    nyseRegularCloseAnchor(new Date(friday.getTime() - 7 * DAY_MS));

  const scores = await settleLeagueWeek(pool, {
    leagueId,
    season,
    week,
    weekEnd,
    baselineAt,
  });
  const settle = await settleMatchups(pool, leagueId, week, season);

  // Recaps read the just-settled scores; regenerate them so a correction
  // re-surfaces (idempotent upsert). Lowest-criticality — never fail the
  // re-score over it.
  try {
    await generateLeagueRecaps(pool, leagueId, season, week, redis);
  } catch {
    /* recaps are best-effort; the re-score and re-settle already committed */
  }

  await writeAudit(pool, {
    leagueId,
    actorUserId,
    action: 'score.rescore',
    detail: {
      week,
      season,
      reason: opts.reason ?? null,
      managersScored: scores.length,
      matchupsSettled: settle.settled,
    },
  });

  return { season, week, scores, settle };
}

// --- Force-advance ----------------------------------------------------------

export interface AdvanceOptions {
  reason?: string | undefined;
  season?: number | undefined;
  /** The week to settle/close; defaults to the MVP scoring week (1). */
  week?: number | undefined;
}

export interface AdvanceResult {
  season: number;
  week: number;
  settle: SettleResult;
}

/**
 * Force-advance a stuck week. Settles its matchups off whatever scores exist
 * (a missing manager scores 0), rebuilds standings, and drives the FS-08
 * season→playoffs transition — the same pipeline the Friday job runs, on demand.
 * Pair with rescoreWeek first if the dispute is bad numbers rather than a
 * never-ran settle. Recorded after the settle succeeds.
 */
export async function forceAdvance(
  pool: Pool,
  leagueId: string,
  actorUserId: string,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult> {
  await assertCommissioner(pool, leagueId, actorUserId);
  const season = opts.season ?? 1;
  const week = opts.week ?? 1;
  assertWeek(week);

  const settle = await settleMatchups(pool, leagueId, week, season);

  await writeAudit(pool, {
    leagueId,
    actorUserId,
    action: 'season.advance',
    detail: {
      week,
      season,
      reason: opts.reason ?? null,
      settled: settle.settled,
      enteredPlayoffs: settle.enteredPlayoffs,
      championUserId: settle.championUserId,
    },
  });

  return { season, week, settle };
}

// --- Lineup override --------------------------------------------------------

export interface LineupOverrideInput {
  season?: number | undefined;
  week: number;
  /** Slots to set on the manager's behalf (bypasses the weekly lock). */
  slots?:
    | { slot: string; slotIndex?: number | undefined; symbol: string }[]
    | undefined;
  /** Clear the lineup's lock so the manager can edit again. */
  unlock?: boolean | undefined;
  /** Re-stamp the lock after setting (e.g. recover from a lock-job miss). */
  lock?: boolean | undefined;
  reason?: string | undefined;
}

/**
 * Override a manager's lineup in an exceptional case (a lock-job miss, a bad
 * auto-fill). Either unlock the week so the manager can edit, or set the lineup
 * directly on their behalf — setting bypasses the lock, and `lock: true`
 * re-stamps it afterwards. Recorded with the target and reason.
 */
export async function overrideLineup(
  pool: Pool,
  leagueId: string,
  targetUserId: string,
  input: LineupOverrideInput,
  actorUserId: string,
): Promise<Lineup> {
  await assertCommissioner(pool, leagueId, actorUserId);
  assertWeek(input.week);
  const season = input.season ?? 1;
  const hasSlots = !!input.slots && input.slots.length > 0;
  if (!hasSlots && input.unlock !== true) {
    throw new FantasyError(
      'VALIDATION',
      'Provide slots to set, or unlock=true',
    );
  }
  if ((await memberRole(pool, leagueId, targetUserId)) === null) {
    throw new FantasyError('NOT_FOUND', 'User is not a member of this league');
  }

  // Ensure a row exists, then clear the lock so an unlock takes effect and a set
  // can proceed past setLineup's LINEUP_LOCKED guard.
  await ensureLineupRow(pool, leagueId, targetUserId, season, input.week);
  await pool.query(
    `UPDATE fs_lineup SET locked_at = NULL, updated_at = now()
      WHERE league_id = $1 AND user_id = $2 AND season = $3 AND week = $4`,
    [leagueId, targetUserId, season, input.week],
  );

  if (hasSlots) {
    await setLineup(pool, leagueId, targetUserId, {
      season,
      week: input.week,
      slots: input.slots!,
    });
  }
  if (input.lock === true) {
    await pool.query(
      `UPDATE fs_lineup SET locked_at = now(), updated_at = now()
        WHERE league_id = $1 AND user_id = $2 AND season = $3 AND week = $4`,
      [leagueId, targetUserId, season, input.week],
    );
  }

  await writeAudit(pool, {
    leagueId,
    actorUserId,
    action: 'lineup.override',
    detail: {
      targetUserId,
      week: input.week,
      season,
      set: hasSlots,
      unlocked: input.unlock === true && !input.lock,
      relocked: input.lock === true,
      reason: input.reason ?? null,
    },
  });

  return getLineup(pool, leagueId, targetUserId, input.week, season);
}

// --- Platform ops: FS health ------------------------------------------------

const LEAGUE_STATUSES: LeagueStatus[] = [
  'forming',
  'drafting',
  'active',
  'playoffs',
  'archived',
];

/**
 * Per-fleet Fantasy Street health for the admin ops view: league counts by
 * status, drafts in progress, the last scoring run per league, and any stuck
 * weeks — a locked-but-unscored week that a later settled week has surpassed
 * (a genuine settle gap, not the in-progress current week).
 */
export async function fantasyHealth(pool: Pool): Promise<FantasyHealth> {
  const byStatus = await pool.query<{ status: LeagueStatus; count: number }>(
    `SELECT status, count(*)::int AS count FROM fs_league GROUP BY status`,
  );
  const leaguesByStatus = Object.fromEntries(
    LEAGUE_STATUSES.map((s) => [s, 0]),
  ) as Record<LeagueStatus, number>;
  for (const r of byStatus.rows) leaguesByStatus[r.status] = r.count;

  const drafts = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM fs_draft WHERE status = 'in_progress'`,
  );

  const stuck = await pool.query<{
    league_id: string;
    season: number;
    week: number;
  }>(
    `SELECT DISTINCT l.league_id, l.season, l.week
       FROM fs_lineup l
       JOIN fs_league lg ON lg.id = l.league_id
      WHERE lg.status IN ('active', 'playoffs')
        AND l.locked_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM fs_weekly_score s
           WHERE s.league_id = l.league_id AND s.season = l.season
             AND s.week = l.week)
        AND EXISTS (
          SELECT 1 FROM fs_weekly_score s2
           WHERE s2.league_id = l.league_id AND s2.season = l.season
             AND s2.week > l.week)
      ORDER BY l.league_id, l.season, l.week`,
  );

  const lastRuns = await pool.query<{ league_id: string; last_run_at: Date }>(
    `SELECT league_id, max(computed_at) AS last_run_at
       FROM fs_weekly_score GROUP BY league_id`,
  );

  return {
    leaguesByStatus,
    draftsInProgress: drafts.rows[0]?.count ?? 0,
    stuckWeeks: stuck.rows.map((r) => ({
      leagueId: r.league_id,
      season: r.season,
      week: r.week,
    })),
    lastScoringRunByLeague: lastRuns.rows.map((r) => ({
      leagueId: r.league_id,
      lastRunAt: r.last_run_at.toISOString(),
    })),
  };
}
