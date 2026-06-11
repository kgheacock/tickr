/**
 * Fantasy Street — leagues & membership domain logic (item 01).
 *
 * Thin, pool-driven functions that throw FantasyError for any non-2xx outcome,
 * keeping the Fastify handlers in routes/leagues/* as pure glue. Mirrors the
 * createEtf / loadPrices pattern (etf/crud.ts, routes/prices.ts).
 *
 * Authorization lives here, not only in the route guards: membership/role
 * checks take a userId and query the DB the way requireAdmin does, so the
 * authz rules (a DoD bar) are exercised by the domain tests without Redis.
 */
import { randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  Invite,
  JoinPolicy,
  LeagueListResponse,
  LeagueMember,
  LeagueMembership,
  LeagueSummary,
  LeagueView,
  RosterConfig,
} from '@tickr/shared-types';

// Domain-layer input shapes. These mirror the shared CreateLeagueRequest /
// UpdateLeagueRequest / … contract types but spell optionals as `?: T |
// undefined` so values coming straight off zod (`.optional()`) satisfy them
// under tsconfig's exactOptionalPropertyTypes.
export interface CreateLeagueInput {
  name: string;
  size: number;
  seasonLengthWeeks: number;
  rosterConfig?: RosterConfig | undefined;
  joinPolicy: JoinPolicy;
}

export interface UpdateLeagueInput {
  name?: string | undefined;
  size?: number | undefined;
  seasonLengthWeeks?: number | undefined;
  rosterConfig?: RosterConfig | undefined;
  joinPolicy?: JoinPolicy | undefined;
}

export interface CreateInviteInput {
  expiresInHours?: number | undefined;
  maxUses?: number | undefined;
}

export interface JoinLeagueInput {
  token?: string | undefined;
}

/** Carries a stable code the route layer maps to an HTTP status. */
export class FantasyError extends Error {
  constructor(
    public readonly code:
      | 'VALIDATION'
      | 'NOT_FOUND'
      | 'FORBIDDEN'
      | 'CONFLICT'
      | 'ALREADY_OWNED'
      | 'LINEUP_LOCKED'
      | 'INVALID_TOKEN',
    message: string,
  ) {
    super(message);
    this.name = 'FantasyError';
  }
}

/** code → HTTP status, used by every leagues route handler. */
export function fantasyErrorStatus(code: FantasyError['code']): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'FORBIDDEN':
      return 403;
    case 'CONFLICT':
    case 'ALREADY_OWNED':
    case 'LINEUP_LOCKED':
      return 409;
    case 'VALIDATION':
    case 'INVALID_TOKEN':
      return 422;
  }
}

/** Locked slot layout from the epic README + 2 bench. */
export const DEFAULT_ROSTER_CONFIG: RosterConfig = {
  slots: ['Anchor', 'Growth', 'Momentum', 'Value', 'Defense', 'Wildcard'],
  bench: 2,
};

const MAX_BENCH = 4;

/** Non-empty slots, every slot a non-empty string, bench in [0, 4]. */
export function validateRosterConfig(cfg: RosterConfig): void {
  if (!Array.isArray(cfg.slots) || cfg.slots.length === 0) {
    throw new FantasyError(
      'VALIDATION',
      'rosterConfig.slots must be non-empty',
    );
  }
  if (cfg.slots.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new FantasyError(
      'VALIDATION',
      'rosterConfig.slots must all be non-empty strings',
    );
  }
  if (!Number.isInteger(cfg.bench) || cfg.bench < 0 || cfg.bench > MAX_BENCH) {
    throw new FantasyError(
      'VALIDATION',
      `rosterConfig.bench must be 0–${MAX_BENCH}`,
    );
  }
}

// --- DB row shapes ---

interface LeagueRow {
  id: string;
  name: string;
  commissioner_user_id: string;
  size: number;
  season_length_weeks: number;
  roster_config: RosterConfig;
  join_policy: 'invite' | 'open';
  status: LeagueView['status'];
  created_at: Date;
}

interface MemberRow {
  user_id: string;
  display_name: string;
  team_name: string | null;
  role: 'commissioner' | 'manager';
  joined_at: Date;
}

interface InviteRow {
  token: string;
  league_id: string;
  expires_at: Date | null;
  max_uses: number | null;
  uses: number;
  created_at: Date;
}

function toMember(r: MemberRow): LeagueMember {
  return {
    userId: r.user_id,
    displayName: r.display_name,
    teamName: r.team_name,
    role: r.role,
    joinedAt: r.joined_at.toISOString(),
  };
}

function toView(league: LeagueRow, members: MemberRow[]): LeagueView {
  return {
    id: league.id,
    name: league.name,
    commissionerUserId: league.commissioner_user_id,
    size: league.size,
    seasonLengthWeeks: league.season_length_weeks,
    rosterConfig: league.roster_config,
    joinPolicy: league.join_policy,
    status: league.status,
    createdAt: league.created_at.toISOString(),
    members: members.map(toMember),
    openSlots: league.size - members.length,
  };
}

function toInvite(r: InviteRow): Invite {
  return {
    token: r.token,
    leagueId: r.league_id,
    expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
    maxUses: r.max_uses,
    uses: r.uses,
    createdAt: r.created_at.toISOString(),
  };
}

// --- Internal helpers ---

async function loadLeagueRow(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<LeagueRow> {
  const { rows } = await db.query<LeagueRow>(
    `SELECT id, name, commissioner_user_id, size, season_length_weeks,
            roster_config, join_policy, status, created_at
       FROM fs_league WHERE id = $1`,
    [leagueId],
  );
  const row = rows[0];
  if (!row)
    throw new FantasyError('NOT_FOUND', `League not found: ${leagueId}`);
  return row;
}

async function loadMembers(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<MemberRow[]> {
  const { rows } = await db.query<MemberRow>(
    `SELECT m.user_id, u.display_name, m.team_name, m.role, m.joined_at
       FROM fs_league_member m
       JOIN app_user u ON u.id = m.user_id
      WHERE m.league_id = $1
      ORDER BY m.joined_at ASC`,
    [leagueId],
  );
  return rows;
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

/** Throws NOT_FOUND if missing, FORBIDDEN if the user is not a member. */
export async function assertLeagueMember(
  pool: Pool,
  leagueId: string,
  userId: string,
): Promise<void> {
  await loadLeagueRow(pool, leagueId);
  if ((await memberRole(pool, leagueId, userId)) === null) {
    throw new FantasyError('FORBIDDEN', 'League membership required');
  }
}

/** Throws NOT_FOUND if missing, FORBIDDEN unless the user is commissioner. */
export async function assertCommissioner(
  pool: Pool,
  leagueId: string,
  userId: string,
): Promise<void> {
  await loadLeagueRow(pool, leagueId);
  if ((await memberRole(pool, leagueId, userId)) !== 'commissioner') {
    throw new FantasyError('FORBIDDEN', 'Commissioner access required');
  }
}

// --- Public domain operations ---

export async function createLeague(
  input: CreateLeagueInput,
  userId: string,
  pool: Pool,
): Promise<LeagueView> {
  const name = input.name?.trim();
  if (!name) throw new FantasyError('VALIDATION', 'name is required');
  if (!Number.isInteger(input.size) || input.size < 4 || input.size > 12) {
    throw new FantasyError('VALIDATION', 'size must be an integer 4–12');
  }
  if (
    !Number.isInteger(input.seasonLengthWeeks) ||
    input.seasonLengthWeeks < 1
  ) {
    throw new FantasyError(
      'VALIDATION',
      'seasonLengthWeeks must be a positive integer',
    );
  }
  if (input.joinPolicy !== 'invite' && input.joinPolicy !== 'open') {
    throw new FantasyError(
      'VALIDATION',
      "joinPolicy must be 'invite' or 'open'",
    );
  }
  const rosterConfig = input.rosterConfig ?? DEFAULT_ROSTER_CONFIG;
  validateRosterConfig(rosterConfig);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<LeagueRow>(
      `INSERT INTO fs_league
         (name, commissioner_user_id, size, season_length_weeks,
          roster_config, join_policy)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, commissioner_user_id, size, season_length_weeks,
                 roster_config, join_policy, status, created_at`,
      [
        name,
        userId,
        input.size,
        input.seasonLengthWeeks,
        JSON.stringify(rosterConfig),
        input.joinPolicy,
      ],
    );
    const league = rows[0]!;
    // The commissioner is also a member.
    await client.query(
      `INSERT INTO fs_league_member (league_id, user_id, role)
       VALUES ($1, $2, 'commissioner')`,
      [league.id, userId],
    );
    await client.query('COMMIT');
    const members = await loadMembers(client, league.id);
    return toView(league, members);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getLeagueView(
  leagueId: string,
  userId: string,
  pool: Pool,
): Promise<LeagueView> {
  const league = await loadLeagueRow(pool, leagueId);
  const role = await memberRole(pool, leagueId, userId);
  // Members can always view; non-members can view only `open` leagues.
  if (role === null && league.join_policy !== 'open') {
    throw new FantasyError('FORBIDDEN', 'League membership required');
  }
  const members = await loadMembers(pool, leagueId);
  return toView(league, members);
}

export interface ListLeaguesOptions {
  mine?: boolean | undefined;
  open?: boolean | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export async function listLeagues(
  opts: ListLeaguesOptions,
  userId: string,
  pool: Pool,
): Promise<LeagueListResponse> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.mine) {
    params.push(userId);
    where.push(
      `l.id IN (SELECT league_id FROM fs_league_member WHERE user_id = $${params.length})`,
    );
  }
  if (opts.open) {
    // Joinable: open join policy and still forming.
    where.push(`l.join_policy = 'open'`, `l.status = 'forming'`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM fs_league l ${whereSql}`,
    params,
  );
  const total = Number(countRes.rows[0]!.total);

  const { rows } = await pool.query<{
    id: string;
    name: string;
    size: number;
    season_length_weeks: number;
    join_policy: 'invite' | 'open';
    status: LeagueView['status'];
    created_at: Date;
    member_count: string;
  }>(
    `SELECT l.id, l.name, l.size, l.season_length_weeks, l.join_policy,
            l.status, l.created_at,
            (SELECT COUNT(*) FROM fs_league_member m WHERE m.league_id = l.id)::text
              AS member_count
       FROM fs_league l
       ${whereSql}
      ORDER BY l.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  const items: LeagueSummary[] = rows.map((r) => {
    const memberCount = Number(r.member_count);
    return {
      id: r.id,
      name: r.name,
      size: r.size,
      seasonLengthWeeks: r.season_length_weeks,
      joinPolicy: r.join_policy,
      status: r.status,
      memberCount,
      openSlots: r.size - memberCount,
      createdAt: r.created_at.toISOString(),
    };
  });

  return { items, total, limit, offset };
}

export async function createInvite(
  leagueId: string,
  input: CreateInviteInput,
  userId: string,
  pool: Pool,
): Promise<Invite> {
  await assertCommissioner(pool, leagueId, userId);

  if (
    input.maxUses !== undefined &&
    (!Number.isInteger(input.maxUses) || input.maxUses < 1)
  ) {
    throw new FantasyError('VALIDATION', 'maxUses must be a positive integer');
  }
  if (
    input.expiresInHours !== undefined &&
    (!Number.isInteger(input.expiresInHours) || input.expiresInHours < 1)
  ) {
    throw new FantasyError(
      'VALIDATION',
      'expiresInHours must be a positive integer',
    );
  }

  const token = randomBytes(24).toString('base64url');
  const expiresAt =
    input.expiresInHours !== undefined
      ? new Date(Date.now() + input.expiresInHours * 3_600_000)
      : null;

  const { rows } = await pool.query<InviteRow>(
    `INSERT INTO fs_invite (token, league_id, created_by, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING token, league_id, expires_at, max_uses, uses, created_at`,
    [token, leagueId, userId, expiresAt, input.maxUses ?? null],
  );
  return toInvite(rows[0]!);
}

export async function joinLeague(
  leagueId: string,
  input: JoinLeagueInput,
  userId: string,
  pool: Pool,
): Promise<LeagueView> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the league row so concurrent joins can't both pass the size check.
    const { rows: leagueRows } = await client.query<LeagueRow>(
      `SELECT id, name, commissioner_user_id, size, season_length_weeks,
              roster_config, join_policy, status, created_at
         FROM fs_league WHERE id = $1 FOR UPDATE`,
      [leagueId],
    );
    const league = leagueRows[0];
    if (!league) {
      throw new FantasyError('NOT_FOUND', `League not found: ${leagueId}`);
    }

    // Idempotent: an existing member re-joining is a no-op success.
    const existing = await memberRole(client, leagueId, userId);
    if (existing !== null) {
      await client.query('COMMIT');
      const members = await loadMembers(client, leagueId);
      return toView(league, members);
    }

    if (league.status !== 'forming') {
      throw new FantasyError(
        'CONFLICT',
        'League is no longer accepting members',
      );
    }

    const { rows: countRows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM fs_league_member WHERE league_id = $1`,
      [leagueId],
    );
    if (Number(countRows[0]!.count) >= league.size) {
      throw new FantasyError('CONFLICT', 'League is full');
    }

    // Token rules: required for invite-only leagues; consumes a use.
    if (league.join_policy === 'invite' || input.token) {
      if (!input.token) {
        throw new FantasyError(
          'INVALID_TOKEN',
          'An invite token is required for this league',
        );
      }
      const { rows: inviteRows } = await client.query<InviteRow>(
        `SELECT token, league_id, expires_at, max_uses, uses, created_at
           FROM fs_invite WHERE token = $1 FOR UPDATE`,
        [input.token],
      );
      const invite = inviteRows[0];
      if (!invite || invite.league_id !== leagueId) {
        throw new FantasyError('INVALID_TOKEN', 'Invalid invite token');
      }
      if (invite.expires_at && invite.expires_at.getTime() <= Date.now()) {
        throw new FantasyError('INVALID_TOKEN', 'Invite token has expired');
      }
      if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
        throw new FantasyError(
          'INVALID_TOKEN',
          'Invite token has no uses left',
        );
      }
      await client.query(
        `UPDATE fs_invite SET uses = uses + 1 WHERE token = $1`,
        [input.token],
      );
    }

    await client.query(
      `INSERT INTO fs_league_member (league_id, user_id, role)
       VALUES ($1, $2, 'manager')`,
      [leagueId, userId],
    );
    await client.query('COMMIT');

    const members = await loadMembers(client, leagueId);
    return toView(league, members);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateLeague(
  leagueId: string,
  input: UpdateLeagueInput,
  userId: string,
  pool: Pool,
): Promise<LeagueView> {
  await assertCommissioner(pool, leagueId, userId);
  const league = await loadLeagueRow(pool, leagueId);
  if (league.status !== 'forming') {
    throw new FantasyError(
      'CONFLICT',
      'Settings can only be edited while the league is forming',
    );
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new FantasyError('VALIDATION', 'name must not be empty');
    set('name', name);
  }
  if (input.size !== undefined) {
    if (!Number.isInteger(input.size) || input.size < 4 || input.size > 12) {
      throw new FantasyError('VALIDATION', 'size must be an integer 4–12');
    }
    // Can't shrink below the current roster.
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
    set('size', input.size);
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
    set('season_length_weeks', input.seasonLengthWeeks);
  }
  if (input.rosterConfig !== undefined) {
    validateRosterConfig(input.rosterConfig);
    set('roster_config', JSON.stringify(input.rosterConfig));
  }
  if (input.joinPolicy !== undefined) {
    if (input.joinPolicy !== 'invite' && input.joinPolicy !== 'open') {
      throw new FantasyError(
        'VALIDATION',
        "joinPolicy must be 'invite' or 'open'",
      );
    }
    set('join_policy', input.joinPolicy);
  }

  if (sets.length > 0) {
    params.push(leagueId);
    await pool.query(
      `UPDATE fs_league SET ${sets.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

  const updated = await loadLeagueRow(pool, leagueId);
  const members = await loadMembers(pool, leagueId);
  return toView(updated, members);
}

/** League memberships for the /me payload. */
export async function getUserLeagues(
  userId: string,
  pool: Pool,
): Promise<LeagueMembership[]> {
  const { rows } = await pool.query<{
    league_id: string;
    team_name: string | null;
    role: 'commissioner' | 'manager';
    status: LeagueView['status'];
  }>(
    `SELECT m.league_id, m.team_name, m.role, l.status
       FROM fs_league_member m
       JOIN fs_league l ON l.id = m.league_id
      WHERE m.user_id = $1
      ORDER BY l.created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    leagueId: r.league_id,
    teamName: r.team_name,
    role: r.role,
    status: r.status,
  }));
}
