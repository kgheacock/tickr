/**
 * Fantasy Street item 03 — live snake draft orchestration.
 *
 * Pure, pool-driven domain logic: schedule, start, make/auto a pick, and read
 * the board. The pick *clock* (Redis deadline + in-process timer) and the WS
 * broadcasts are a thin shell in fantasy/draftClock.ts + routes/leagues/draft.ts
 * that call these functions; everything testable lives here and needs only a
 * Pool (no Redis, no timers) — see test/fantasy/draft.test.ts.
 *
 * The draft is where exclusive ownership is created: every pick writes both
 * fs_draft_pick (the log) and fs_roster_entry (the ownership table). Two
 * Postgres UNIQUE/PK guards back the invariants, both surfacing as 23505 and
 * disambiguated here by constraint name:
 *   - fs_draft.* row lock (FOR UPDATE) serializes all pick attempts for a draft,
 *     so a manual pick and an expiry auto-pick for the same position can't both
 *     win; the loser re-reads and is rejected by the on-the-clock check.
 *   - UNIQUE (league_id, symbol) on fs_roster_entry is the cross-manager guard:
 *     two managers racing for the same symbol → loser gets 409 ALREADY_OWNED.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  DraftPick,
  DraftSlot,
  DraftState,
  RosterConfig,
} from '@tickr/shared-types';
import { FantasyError } from './leagues.js';
import { slotsFor, slotToGroup } from './eligibility.js';
import { chooseAutoPick, normalizeSlot } from './autodraft.js';

// --- Snake order (pure) ----------------------------------------------------

/**
 * Materialize the full snake order: a userId per overall pick (1..N×rounds).
 * Round 0 runs members in order, round 1 reversed, and so on — the snake.
 */
export function computeSnakeOrder(
  memberIds: string[],
  totalRounds: number,
): string[] {
  const order: string[] = [];
  for (let round = 0; round < totalRounds; round++) {
    const seats = round % 2 === 0 ? memberIds : [...memberIds].reverse();
    order.push(...seats);
  }
  return order;
}

// --- DB row shapes ----------------------------------------------------------

interface DraftRow {
  id: string;
  league_id: string;
  status: DraftState['status'];
  pick_seconds: number;
  current_overall_pick: number;
}

interface PickRow {
  overall_pick: number;
  round: number;
  user_id: string;
  symbol: string;
  is_short: boolean;
  auto: boolean;
  picked_at: Date;
}

function toPick(r: PickRow): DraftPick {
  return {
    overallPick: r.overall_pick,
    round: r.round,
    userId: r.user_id,
    symbol: r.symbol,
    isShort: r.is_short,
    auto: r.auto,
    pickedAt: r.picked_at.toISOString(),
  };
}

/** Total picks each manager makes: starting slots + bench. */
export function totalRoundsOf(cfg: RosterConfig): number {
  return cfg.slots.length + cfg.bench;
}

/** Round (1-based) an overall pick falls in, given N managers. */
function roundOf(overallPick: number, n: number): number {
  return Math.floor((overallPick - 1) / n) + 1;
}

// --- Loaders ---------------------------------------------------------------

interface LeagueDraftContext {
  draft: DraftRow;
  memberIds: string[];
  rosterConfig: RosterConfig;
  order: string[];
  totalPicks: number;
}

async function loadDraftRow(
  db: Pool | PoolClient,
  leagueId: string,
  forUpdate = false,
): Promise<DraftRow | null> {
  const { rows } = await db.query<DraftRow>(
    `SELECT id, league_id, status, pick_seconds, current_overall_pick
       FROM fs_draft WHERE league_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [leagueId],
  );
  return rows[0] ?? null;
}

/** Members in their frozen draft order (join order; commissioner first). */
async function loadMemberIds(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM fs_league_member
      WHERE league_id = $1 ORDER BY joined_at ASC, user_id ASC`,
    [leagueId],
  );
  return rows.map((r) => r.user_id);
}

async function loadRosterConfig(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<RosterConfig> {
  const { rows } = await db.query<{ roster_config: RosterConfig }>(
    `SELECT roster_config FROM fs_league WHERE id = $1`,
    [leagueId],
  );
  if (!rows[0]) throw new FantasyError('NOT_FOUND', 'League not found');
  return rows[0].roster_config;
}

async function loadContext(
  db: Pool | PoolClient,
  leagueId: string,
  forUpdate = false,
): Promise<LeagueDraftContext> {
  const draft = await loadDraftRow(db, leagueId, forUpdate);
  if (!draft) throw new FantasyError('NOT_FOUND', 'No draft for this league');
  const [memberIds, rosterConfig] = await Promise.all([
    loadMemberIds(db, leagueId),
    loadRosterConfig(db, leagueId),
  ]);
  const order = computeSnakeOrder(memberIds, totalRoundsOf(rosterConfig));
  return { draft, memberIds, rosterConfig, order, totalPicks: order.length };
}

// --- State assembly --------------------------------------------------------

async function assembleState(
  db: Pool | PoolClient,
  ctx: LeagueDraftContext,
  deadline: string | null = null,
): Promise<DraftState> {
  const { draft, memberIds, order, totalPicks } = ctx;
  const { rows } = await db.query<PickRow>(
    `SELECT overall_pick, round, user_id, symbol, is_short, auto, picked_at
       FROM fs_draft_pick WHERE draft_id = $1 ORDER BY overall_pick ASC`,
    [draft.id],
  );
  const n = memberIds.length;
  const slots: DraftSlot[] = order.map((userId, i) => ({
    overallPick: i + 1,
    round: roundOf(i + 1, n),
    userId,
  }));
  const onClockUserId =
    draft.current_overall_pick <= totalPicks
      ? (order[draft.current_overall_pick - 1] ?? null)
      : null;
  return {
    id: draft.id,
    leagueId: draft.league_id,
    status: draft.status,
    pickSeconds: draft.pick_seconds,
    totalRounds: totalPicks / Math.max(n, 1),
    totalPicks,
    currentOverallPick: draft.current_overall_pick,
    onClockUserId,
    deadline: draft.status === 'in_progress' ? deadline : null,
    order: slots,
    picks: rows.map(toPick),
  };
}

/** Read the current draft board for a league, or null if none exists. */
export async function getDraftState(
  pool: Pool,
  leagueId: string,
  deadline: string | null = null,
): Promise<DraftState | null> {
  const draft = await loadDraftRow(pool, leagueId);
  if (!draft) return null;
  const ctx = await loadContext(pool, leagueId);
  return assembleState(pool, ctx, deadline);
}

// --- Schedule / start ------------------------------------------------------

/**
 * Commissioner schedules the draft for a full, still-forming league. Computes
 * the snake order, flips the league to `drafting`, and writes a `scheduled`
 * draft. Idempotent guard: a league already has at most one draft (UNIQUE).
 */
export async function scheduleDraft(
  pool: Pool,
  leagueId: string,
): Promise<DraftState> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: leagueRows } = await client.query<{
      size: number;
      status: string;
      member_count: string;
    }>(
      `SELECT l.size, l.status,
              (SELECT count(*) FROM fs_league_member m WHERE m.league_id = l.id)::text
                AS member_count
         FROM fs_league l WHERE l.id = $1 FOR UPDATE`,
      [leagueId],
    );
    const league = leagueRows[0];
    if (!league) throw new FantasyError('NOT_FOUND', 'League not found');
    if (league.status !== 'forming') {
      throw new FantasyError('CONFLICT', 'League is not forming');
    }
    if (Number(league.member_count) < league.size) {
      throw new FantasyError('CONFLICT', 'League is not full yet');
    }
    if (await loadDraftRow(client, leagueId)) {
      throw new FantasyError('CONFLICT', 'Draft already scheduled');
    }
    await client.query(
      `INSERT INTO fs_draft (league_id, status) VALUES ($1, 'scheduled')`,
      [leagueId],
    );
    await client.query(
      `UPDATE fs_league SET status = 'drafting' WHERE id = $1`,
      [leagueId],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const state = await getDraftState(pool, leagueId);
  return state!;
}

/**
 * Commissioner starts a scheduled draft: status → in_progress, the first seat
 * goes on the clock. The Redis deadline + timer are armed by the caller.
 */
export async function startDraft(
  pool: Pool,
  leagueId: string,
): Promise<DraftState> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const draft = await loadDraftRow(client, leagueId, true);
    if (!draft) throw new FantasyError('NOT_FOUND', 'No draft for this league');
    if (draft.status !== 'scheduled') {
      throw new FantasyError(
        'CONFLICT',
        `Draft is ${draft.status}, not scheduled`,
      );
    }
    await client.query(
      `UPDATE fs_draft
          SET status = 'in_progress', started_at = now(), current_overall_pick = 1
        WHERE id = $1`,
      [draft.id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const state = await getDraftState(pool, leagueId);
  return state!;
}

// --- Picks -----------------------------------------------------------------

export interface PickResult {
  pick: DraftPick;
  state: DraftState;
  completed: boolean;
}

function isUniqueViolation(err: unknown): { constraint: string } | null {
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  ) {
    return { constraint: (err as { constraint?: string }).constraint ?? '' };
  }
  return null;
}

/**
 * Validate a symbol is tradeable and can stand in for some roster slot. Shared
 * with waivers (FS-07): a waiver add must clear the same eligibility bar as a
 * draft pick.
 */
export async function validatePickable(
  client: Pool | PoolClient,
  leagueId: string,
  cfg: RosterConfig,
  symbol: string,
  isShort: boolean,
): Promise<void> {
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM universe_symbol us
        WHERE us.symbol = $1
          AND us.removed_at IS NULL
          AND us.backfilled = true
          AND us.data_status IS DISTINCT FROM 'incomplete'
     ) AS ok`,
    [symbol],
  );
  if (!rows[0]?.ok) {
    throw new FantasyError('VALIDATION', `Symbol is not tradeable: ${symbol}`);
  }
  const cfgSlots = new Set(cfg.slots.map((s) => normalizeSlot(s)));
  if (isShort) {
    // A short occupies the Defense slot (universal eligibility).
    if (!cfgSlots.has('Defense')) {
      throw new FantasyError('VALIDATION', 'This roster has no Defense slot');
    }
    return;
  }
  // A long must be eligible for some non-Defense slot in the roster config.
  const eligible = new Set(await slotsFor(client, symbol));
  const fits = [...cfgSlots].some(
    (s) => s !== 'Defense' && slotToGroup(s) !== null && eligible.has(s),
  );
  if (!fits) {
    throw new FantasyError(
      'VALIDATION',
      `${symbol} is not eligible for any roster slot`,
    );
  }
}

/**
 * Apply a pick within an open transaction holding the fs_draft row lock. Writes
 * fs_draft_pick + fs_roster_entry, advances the clock, and completes the draft
 * (league → active) on the final pick. Shared by manual and auto picks.
 */
async function applyPick(
  client: PoolClient,
  ctx: LeagueDraftContext,
  userId: string,
  symbol: string,
  isShort: boolean,
  auto: boolean,
): Promise<PickResult> {
  const { draft, memberIds, rosterConfig, order, totalPicks } = ctx;
  if (draft.status !== 'in_progress') {
    throw new FantasyError('CONFLICT', `Draft is ${draft.status}`);
  }
  const overall = draft.current_overall_pick;
  if (overall > totalPicks) {
    throw new FantasyError('CONFLICT', 'Draft is already over');
  }
  if (order[overall - 1] !== userId) {
    throw new FantasyError('FORBIDDEN', 'It is not your turn to pick');
  }

  const sym = symbol.toUpperCase();
  await validatePickable(client, draft.league_id, rosterConfig, sym, isShort);

  const round = roundOf(overall, memberIds.length);

  // Ownership write — UNIQUE (league_id, symbol) is the single-owner guard.
  try {
    await client.query(
      `INSERT INTO fs_roster_entry
         (league_id, user_id, symbol, is_short, acquired_via)
       VALUES ($1, $2, $3, $4, 'draft')`,
      [draft.league_id, userId, sym, isShort],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new FantasyError(
        'ALREADY_OWNED',
        `${sym} is already owned in this league`,
      );
    }
    throw err;
  }

  // Pick log — PK (draft_id, overall_pick) backstops the position race.
  try {
    await client.query(
      `INSERT INTO fs_draft_pick
         (draft_id, overall_pick, round, user_id, symbol, is_short, auto)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [draft.id, overall, round, userId, sym, isShort, auto],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new FantasyError('CONFLICT', 'That pick was already made');
    }
    throw err;
  }

  const nextPick = overall + 1;
  const completed = nextPick > totalPicks;
  if (completed) {
    await client.query(
      `UPDATE fs_draft
          SET current_overall_pick = $2, status = 'complete', completed_at = now()
        WHERE id = $1`,
      [draft.id, nextPick],
    );
    await client.query(`UPDATE fs_league SET status = 'active' WHERE id = $1`, [
      draft.league_id,
    ]);
    draft.status = 'complete';
  } else {
    await client.query(
      `UPDATE fs_draft SET current_overall_pick = $2 WHERE id = $1`,
      [draft.id, nextPick],
    );
  }
  draft.current_overall_pick = nextPick;

  const state = await assembleState(client, ctx);
  const pick = state.picks.find((p) => p.overallPick === overall)!;
  return { pick, state, completed };
}

/** The authenticated, on-the-clock manager makes a pick. */
export async function makePick(
  pool: Pool,
  leagueId: string,
  userId: string,
  symbol: string,
  isShort: boolean,
): Promise<PickResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await loadContext(client, leagueId, true);
    const result = await applyPick(client, ctx, userId, symbol, isShort, false);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Auto-pick for whoever is currently on the clock (deadline expiry, or an
 * auto-manager). Picks best-available-by-need and writes with auto=true. Returns
 * null when the draft isn't running or the corpus is exhausted.
 *
 * `expectedPick` guards the expiry race: a clock fires for overall pick N, but a
 * manual pick for N can commit while this txn waits on the fs_draft row lock,
 * advancing to N+1. Without the guard the auto-pick would burn N+1's turn. When
 * the loaded position no longer matches the seat the clock fired for, bail.
 */
export async function autoPickOnClock(
  pool: Pool,
  leagueId: string,
  expectedPick?: number,
): Promise<PickResult | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctx = await loadContext(client, leagueId, true);
    if (
      ctx.draft.status !== 'in_progress' ||
      ctx.draft.current_overall_pick > ctx.totalPicks ||
      (expectedPick !== undefined &&
        ctx.draft.current_overall_pick !== expectedPick)
    ) {
      await client.query('ROLLBACK');
      return null;
    }
    const userId = ctx.order[ctx.draft.current_overall_pick - 1]!;
    const choice = await chooseAutoPick(
      client,
      leagueId,
      userId,
      ctx.rosterConfig,
    );
    if (!choice) {
      await client.query('ROLLBACK');
      return null;
    }
    const result = await applyPick(
      client,
      ctx,
      userId,
      choice.symbol,
      choice.isShort,
      true,
    );
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
