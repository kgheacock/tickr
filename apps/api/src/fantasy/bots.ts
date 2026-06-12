/**
 * Fantasy Street item 10 — auto-managers ("bots").
 *
 * A bot is an ordinary league member: a reserved `app_user` with no identity
 * rows, added as an `fs_league_member` and flagged in `fs_bot_member`. Every
 * league code path (draft order, ownership, scoring, matchups, standings) treats
 * it like any manager — the only difference is a bot never acts interactively,
 * so the existing auto paths always fire for it: the FS-03 draft clock picks for
 * it instantly (see draftClock.arm), and the FS-04 Monday lock auto-fills its
 * lineup (lock.ts already iterates every member, bots included).
 *
 * Modeled on the surviving system-user seed (bootstrap/system-user.ts), not on
 * the bot infra deleted by platformization (no `bot` role, no `algo` table).
 */
import type { Pool, PoolClient } from 'pg';
import type { LeagueView } from '@tickr/shared-types';
import { FantasyError, assertCommissioner, getLeagueView } from './leagues.js';

type Db = Pool | PoolClient;

/**
 * Display-name pool for minted bots, cycled by the league's existing bot count
 * so names stay distinct and stable within a league. Purely cosmetic — bots are
 * keyed by id, not name.
 */
const BOT_NAMES = [
  'CPU — Bull',
  'CPU — Bear',
  'CPU — Quant',
  'CPU — Momentum',
  'CPU — Value',
  'CPU — Contrarian',
  'CPU — Index',
  'CPU — Wildcard',
  'CPU — Algo',
  'CPU — Ticker',
  'CPU — Short',
  'CPU — Hedge',
] as const;

const MAX_BOTS_PER_CALL = 12;

/** Whether `userId` is an auto-manager in `leagueId` (draft-clock hot path). */
export async function isBotMember(
  db: Db,
  leagueId: string,
  userId: string,
): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM fs_bot_member WHERE league_id = $1 AND user_id = $2
     ) AS ok`,
    [leagueId, userId],
  );
  return rows[0]?.ok === true;
}

/**
 * Commissioner fills empty slots with `count` auto-managers while the league is
 * still `forming`. Each bot is a freshly minted `app_user` (no identities) added
 * as a manager and flagged in `fs_bot_member`. Errors if `count` exceeds the
 * open-slot count, so the caller sees an explicit conflict rather than a silent
 * clamp. Returns the updated league view.
 */
export async function addBots(
  pool: Pool,
  leagueId: string,
  count: number,
  callerUserId: string,
): Promise<LeagueView> {
  await assertCommissioner(pool, leagueId, callerUserId);
  if (!Number.isInteger(count) || count < 1 || count > MAX_BOTS_PER_CALL) {
    throw new FantasyError(
      'VALIDATION',
      `count must be an integer 1–${MAX_BOTS_PER_CALL}`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the league row so concurrent joins/bot-adds can't both pass the
    // open-slot check (mirrors joinLeague).
    const { rows: leagueRows } = await client.query<{
      size: number;
      status: string;
      member_count: string;
      bot_count: string;
    }>(
      `SELECT l.size, l.status,
              (SELECT count(*) FROM fs_league_member m WHERE m.league_id = l.id)::text
                AS member_count,
              (SELECT count(*) FROM fs_bot_member b WHERE b.league_id = l.id)::text
                AS bot_count
         FROM fs_league l WHERE l.id = $1 FOR UPDATE`,
      [leagueId],
    );
    const league = leagueRows[0];
    if (!league) throw new FantasyError('NOT_FOUND', 'League not found');
    if (league.status !== 'forming') {
      throw new FantasyError(
        'CONFLICT',
        'Auto-managers can only be added while the league is forming',
      );
    }
    const openSlots = league.size - Number(league.member_count);
    if (count > openSlots) {
      throw new FantasyError(
        'CONFLICT',
        `Only ${openSlots} open slot(s); cannot add ${count} auto-managers`,
      );
    }

    let nameOffset = Number(league.bot_count);
    for (let i = 0; i < count; i++) {
      const displayName =
        BOT_NAMES[nameOffset % BOT_NAMES.length] ?? `CPU — ${nameOffset + 1}`;
      nameOffset += 1;
      const { rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO app_user (id, display_name, email, role)
         VALUES (gen_random_uuid(), $1, NULL, 'player') RETURNING id`,
        [displayName],
      );
      const userId = userRows[0]!.id;
      await client.query(
        `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
         VALUES ($1, $2, 'manager', $3)`,
        [leagueId, userId, displayName],
      );
      await client.query(
        `INSERT INTO fs_bot_member (league_id, user_id) VALUES ($1, $2)`,
        [leagueId, userId],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getLeagueView(leagueId, callerUserId, pool);
}

/**
 * Commissioner removes a single auto-manager before the draft, freeing its slot.
 * Deleting the bot's reserved `app_user` cascades away its membership and
 * `fs_bot_member` flag. Only `fs_bot_member` rows are removable this way — a
 * human manager is never touched.
 */
export async function removeBot(
  pool: Pool,
  leagueId: string,
  botUserId: string,
  callerUserId: string,
): Promise<LeagueView> {
  await assertCommissioner(pool, leagueId, callerUserId);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: leagueRows } = await client.query<{ status: string }>(
      `SELECT status FROM fs_league WHERE id = $1 FOR UPDATE`,
      [leagueId],
    );
    const league = leagueRows[0];
    if (!league) throw new FantasyError('NOT_FOUND', 'League not found');
    if (league.status !== 'forming') {
      throw new FantasyError(
        'CONFLICT',
        'Auto-managers can only be removed while the league is forming',
      );
    }
    const { rows: botRows } = await client.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM fs_bot_member WHERE league_id = $1 AND user_id = $2
       ) AS ok`,
      [leagueId, botUserId],
    );
    if (botRows[0]?.ok !== true) {
      throw new FantasyError(
        'NOT_FOUND',
        'No such auto-manager in this league',
      );
    }
    // Membership first (no cascade from app_user → fs_league_member), then the
    // reserved user; the latter cascades the fs_bot_member flag.
    await client.query(
      `DELETE FROM fs_league_member WHERE league_id = $1 AND user_id = $2`,
      [leagueId, botUserId],
    );
    await client.query(`DELETE FROM app_user WHERE id = $1`, [botUserId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getLeagueView(leagueId, callerUserId, pool);
}
