/**
 * Fantasy Street — immediate free-agent transactions (buy / sell).
 *
 * Distinct from the waiver *queue* (fantasy/waivers.ts), which batches contested
 * add/drop claims and resolves them between weeks by rolling priority. This is
 * the uncontested, real-time path a manager drives from the UI:
 *   - sell (drop): give an owned stock back to the wire; the roster spot opens.
 *   - buy  (add):  claim an unowned stock; if the roster is already full the add
 *                  must be paired with a drop, applied atomically.
 *
 * Like a trade accept, both are real-time roster mutations, so both are gated by
 * the unlocked window (assertWindowOpen) — a locked, unsettled week rejects them
 * and the manager must use the waiver queue instead. The add reuses the waiver
 * run's award shape: insert under the single-owner UNIQUE (league_id, symbol)
 * guard (a lost race surfaces as ALREADY_OWNED), then delete the paired drop, all
 * in one transaction. See test/fantasy/roster.test.ts.
 */
import type { Pool, PoolClient } from 'pg';
import type { RosterTransactionResult } from '@tickr/shared-types';
import { FantasyError } from './leagues.js';
import { loadRosterConfig } from './lineup.js';
import { validatePickable, totalRoundsOf } from './draft.js';
import { assertWindowOpen } from './waivers.js';

type Db = Pool | PoolClient;

/** A unique-violation on the ownership write (the single-owner guard firing). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}

/** How many stocks the caller currently owns in this league. */
async function rosterCount(
  db: Db,
  leagueId: string,
  userId: string,
): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM fs_roster_entry
      WHERE league_id = $1 AND user_id = $2`,
    [leagueId, userId],
  );
  return rows[0]?.n ?? 0;
}

export interface AddPlayerInput {
  addSymbol: string;
  /** Required only when the roster is already full; the stock to drop for it. */
  dropSymbol?: string | undefined;
  /** Add into the Defense (short) slot. */
  isShort?: boolean | undefined;
}

/**
 * Buy an unowned stock off the wire. Validates the add is tradeable, slot-eligible
 * and currently free; if the roster is at capacity (starting slots + bench) the
 * caller must name a stock they own to drop, and the swap is atomic. Returns the
 * symbols that moved.
 */
export async function addPlayer(
  pool: Pool,
  leagueId: string,
  userId: string,
  input: AddPlayerInput,
  season = 1,
): Promise<RosterTransactionResult> {
  const add = input.addSymbol?.trim().toUpperCase();
  const drop = input.dropSymbol?.trim().toUpperCase() || null;
  const isShort = input.isShort === true;
  if (!add) throw new FantasyError('VALIDATION', 'addSymbol is required');
  if (drop && drop === add) {
    throw new FantasyError('VALIDATION', 'add and drop must differ');
  }

  const cfg = await loadRosterConfig(pool, leagueId);
  // Same eligibility bar as a draft pick: tradeable + fits some roster slot.
  await validatePickable(pool, leagueId, cfg, add, isShort);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertWindowOpen(client, leagueId, season);

    // The drop, when given, must be on the caller's roster.
    if (drop) {
      const mine = await client.query(
        `SELECT 1 FROM fs_roster_entry
          WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
        [leagueId, userId, drop],
      );
      if (!mine.rowCount) {
        throw new FantasyError('VALIDATION', `You do not own ${drop}`);
      }
    } else {
      // No drop offered — the add must fit within the roster cap on its own.
      const count = await rosterCount(client, leagueId, userId);
      if (count >= totalRoundsOf(cfg)) {
        throw new FantasyError(
          'CONFLICT',
          'Your roster is full; choose a stock to drop',
        );
      }
    }

    // Insert the add first (single-owner guard catches a same-symbol race), then
    // release the drop. Either failing rolls the whole buy back.
    try {
      await client.query(
        `INSERT INTO fs_roster_entry
           (league_id, user_id, symbol, is_short, acquired_via)
         VALUES ($1, $2, $3, $4, 'free_agent')`,
        [leagueId, userId, add, isShort],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new FantasyError(
          'ALREADY_OWNED',
          `${add} is already owned in this league`,
        );
      }
      throw err;
    }

    if (drop) {
      const del = await client.query(
        `DELETE FROM fs_roster_entry
          WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
        [leagueId, userId, drop],
      );
      if (del.rowCount !== 1) {
        throw new FantasyError('VALIDATION', `You do not own ${drop}`);
      }
    }

    await client.query('COMMIT');
    return { leagueId, added: add, dropped: drop };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Sell (drop) a stock the caller owns back to the wire, opening its roster spot.
 * Gated by the unlocked window like every real-time roster mutation; a stock the
 * caller doesn't own is NOT_FOUND.
 */
export async function dropPlayer(
  pool: Pool,
  leagueId: string,
  userId: string,
  symbol: string,
  season = 1,
): Promise<RosterTransactionResult> {
  const drop = symbol?.trim().toUpperCase();
  if (!drop) throw new FantasyError('VALIDATION', 'symbol is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertWindowOpen(client, leagueId, season);

    const del = await client.query(
      `DELETE FROM fs_roster_entry
        WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
      [leagueId, userId, drop],
    );
    if (del.rowCount !== 1) {
      throw new FantasyError('NOT_FOUND', `You do not own ${drop}`);
    }

    await client.query('COMMIT');
    return { leagueId, added: null, dropped: drop };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
