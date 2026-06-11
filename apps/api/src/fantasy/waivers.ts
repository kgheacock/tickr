/**
 * Fantasy Street item 07 — waiver claims (add/drop) + the rolling waiver run.
 *
 * A manager queues a claim (add an undrafted stock, drop one of theirs); the
 * waiver run — fired from the scheduler after the Friday settle, once standings
 * are rebuilt — awards each contested add to the highest-priority (worst-ranked)
 * claimant, demotes that winner to the back of the order, and marks the rest.
 *
 * Two invariants are load-bearing here:
 *   - single-owner: every add inserts into fs_roster_entry under its
 *     UNIQUE (league_id, symbol) guard; an add is always paired with the drop in
 *     one transaction, so roster size never changes.
 *   - the unlocked window: a transaction only *resolves* between weeks. The
 *     window is closed while a lineup is locked but its week has not settled —
 *     keyed off fs_weekly_score (written at settle), not the never-cleared
 *     locked_at. Mid-week the run skips a league; post-settle it processes it.
 *
 * Pure-ish, pool-driven; the only side effect beyond the DB is the post-commit
 * waiver.processed publish. See test/fantasy/waivers.test.ts.
 */
import type { Pool, PoolClient } from 'pg';
import type { Redis } from 'ioredis';
import type {
  WaiverClaim,
  WaiverOrderEntry,
  WaiversResponse,
} from '@tickr/shared-types';
import { FantasyError } from './leagues.js';
import { loadRosterConfig } from './lineup.js';
import { validatePickable } from './draft.js';
import { publishWaiverProcessed } from '../events/publisher.js';

type Db = Pool | PoolClient;

interface ClaimRow {
  id: string;
  league_id: string;
  season: number;
  user_id: string;
  add_symbol: string;
  drop_symbol: string;
  is_short: boolean;
  status: WaiverClaim['status'];
  submitted_at: Date;
  processed_at: Date | null;
}

const CLAIM_COLS = `id, league_id, season, user_id, add_symbol, drop_symbol,
        is_short, status, submitted_at, processed_at`;

function toClaim(r: ClaimRow): WaiverClaim {
  return {
    id: r.id,
    leagueId: r.league_id,
    season: r.season,
    userId: r.user_id,
    addSymbol: r.add_symbol,
    dropSymbol: r.drop_symbol,
    isShort: r.is_short,
    status: r.status,
    submittedAt: r.submitted_at.toISOString(),
    processedAt: r.processed_at ? r.processed_at.toISOString() : null,
  };
}

/** A unique-violation on an ownership write (the single-owner guard firing). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505'
  );
}

// --- The unlocked-window gate ----------------------------------------------

/** True while the league has a locked-but-unsettled week (window closed). */
async function windowClosed(
  db: Db,
  leagueId: string,
  season: number,
): Promise<boolean> {
  const { rows } = await db.query<{ closed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM fs_lineup l
        WHERE l.league_id = $1 AND l.season = $2 AND l.locked_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM fs_weekly_score ws
             WHERE ws.league_id = l.league_id
               AND ws.season = l.season
               AND ws.week = l.week
          )
     ) AS closed`,
    [leagueId, season],
  );
  return rows[0]?.closed ?? false;
}

/**
 * Guard a real-time roster mutation (a trade accept, or any immediate path):
 * throws LINEUP_LOCKED while a lineup is locked and unsettled. Shared with
 * trades.ts — the single source of truth for "is the transaction window open?".
 */
export async function assertWindowOpen(
  db: Db,
  leagueId: string,
  season = 1,
): Promise<void> {
  if (await windowClosed(db, leagueId, season)) {
    throw new FantasyError(
      'LINEUP_LOCKED',
      'Roster transactions are closed while lineups are locked; they resolve between weeks',
    );
  }
}

// --- Submit a claim ---------------------------------------------------------

export interface WaiverClaimInput {
  addSymbol: string;
  dropSymbol: string;
  isShort?: boolean | undefined;
}

/**
 * Queue a waiver claim. Validates the add is tradeable, slot-eligible and
 * currently unowned, and the drop is on the caller's roster — then writes it
 * `pending` for the next waiver run. Submission is allowed any time (claims
 * batch through the week); only *resolution* waits for the unlocked window.
 */
export async function submitWaiverClaim(
  pool: Pool,
  leagueId: string,
  userId: string,
  input: WaiverClaimInput,
  season = 1,
): Promise<WaiverClaim> {
  const add = input.addSymbol?.trim().toUpperCase();
  const drop = input.dropSymbol?.trim().toUpperCase();
  const isShort = input.isShort === true;
  if (!add) throw new FantasyError('VALIDATION', 'addSymbol is required');
  if (!drop) throw new FantasyError('VALIDATION', 'dropSymbol is required');
  if (add === drop) {
    throw new FantasyError('VALIDATION', 'add and drop must differ');
  }

  const cfg = await loadRosterConfig(pool, leagueId);
  // Same eligibility bar as a draft pick: tradeable + fits some roster slot.
  await validatePickable(pool, leagueId, cfg, add, isShort);

  // The add must be free in this league right now (the run re-checks at award).
  const owned = await pool.query(
    `SELECT 1 FROM fs_roster_entry WHERE league_id = $1 AND symbol = $2`,
    [leagueId, add],
  );
  if (owned.rowCount && owned.rowCount > 0) {
    throw new FantasyError(
      'ALREADY_OWNED',
      `${add} is already owned in this league`,
    );
  }

  // The drop must be on the caller's roster — an add is always paired with one.
  const mine = await pool.query(
    `SELECT 1 FROM fs_roster_entry
      WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
    [leagueId, userId, drop],
  );
  if (!mine.rowCount) {
    throw new FantasyError('VALIDATION', `You do not own ${drop}`);
  }

  const { rows } = await pool.query<ClaimRow>(
    `INSERT INTO fs_waiver_claim
       (league_id, season, user_id, add_symbol, drop_symbol, is_short)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${CLAIM_COLS}`,
    [leagueId, season, userId, add, drop, isShort],
  );
  return toClaim(rows[0]!);
}

// --- Reads ------------------------------------------------------------------

async function loadOrderEntries(
  db: Db,
  leagueId: string,
  season: number,
): Promise<WaiverOrderEntry[]> {
  const { rows } = await db.query<{ user_id: string; priority: number }>(
    `SELECT user_id, priority FROM fs_waiver_order
      WHERE league_id = $1 AND season = $2
      ORDER BY priority`,
    [leagueId, season],
  );
  return rows.map((r) => ({ userId: r.user_id, priority: r.priority }));
}

/**
 * A manager's claims (newest first) and the league's current waiver order. The
 * order is seeded lazily from reverse standings on first read so the priority
 * board is populated before the first run.
 */
export async function listWaivers(
  pool: Pool,
  leagueId: string,
  userId: string,
  season = 1,
): Promise<WaiversResponse> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await seedWaiverOrder(client, leagueId, season);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const { rows } = await pool.query<ClaimRow>(
    `SELECT ${CLAIM_COLS} FROM fs_waiver_claim
      WHERE league_id = $1 AND season = $2 AND user_id = $3
      ORDER BY submitted_at DESC`,
    [leagueId, season, userId],
  );
  const order = await loadOrderEntries(pool, leagueId, season);
  return { season, claims: rows.map(toClaim), order };
}

// --- The waiver run ---------------------------------------------------------

/**
 * Seed fs_waiver_order from reverse standings (worst record claims first) when
 * absent. rank is a total order (1..n) so it carries the full standings
 * tiebreaker chain; unranked managers (no settled games) fall to the back,
 * broken by points-for then user_id for determinism. Idempotent: a no-op once
 * the order exists, so demotions from prior runs are preserved.
 */
async function seedWaiverOrder(
  db: Db,
  leagueId: string,
  season: number,
): Promise<void> {
  const existing = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM fs_waiver_order
      WHERE league_id = $1 AND season = $2`,
    [leagueId, season],
  );
  if ((existing.rows[0]?.n ?? 0) > 0) return;

  const { rows } = await db.query<{ user_id: string }>(
    `SELECT m.user_id
       FROM fs_league_member m
       LEFT JOIN fs_standings s
         ON s.league_id = m.league_id AND s.user_id = m.user_id AND s.season = $2
      WHERE m.league_id = $1
      ORDER BY COALESCE(s.rank, 0) DESC,
               COALESCE(s.points_for, 0) ASC,
               m.user_id ASC`,
    [leagueId, season],
  );
  let priority = 1;
  for (const r of rows) {
    await db.query(
      `INSERT INTO fs_waiver_order (league_id, season, user_id, priority)
       VALUES ($1, $2, $3, $4)`,
      [leagueId, season, r.user_id, priority++],
    );
  }
}

/** Current order as a userId → priority map (lower claims first). */
async function loadPriorityMap(
  db: Db,
  leagueId: string,
  season: number,
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ user_id: string; priority: number }>(
    `SELECT user_id, priority FROM fs_waiver_order
      WHERE league_id = $1 AND season = $2`,
    [leagueId, season],
  );
  return new Map(rows.map((r) => [r.user_id, r.priority]));
}

/** Per-manager points-for (the priority tiebreak); 0 when unranked. */
async function loadPointsFor(
  db: Db,
  leagueId: string,
  season: number,
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ user_id: string; points_for: number }>(
    `SELECT user_id, points_for::float8 AS points_for FROM fs_standings
      WHERE league_id = $1 AND season = $2`,
    [leagueId, season],
  );
  return new Map(rows.map((r) => [r.user_id, r.points_for]));
}

/** Send a winning claimant to the back of the order (rolling priority). */
async function demote(
  db: Db,
  leagueId: string,
  season: number,
  userId: string,
  order: Map<string, number>,
): Promise<void> {
  const next = Math.max(0, ...order.values()) + 1;
  await db.query(
    `UPDATE fs_waiver_order SET priority = $4, updated_at = now()
      WHERE league_id = $1 AND season = $2 AND user_id = $3`,
    [leagueId, season, userId, next],
  );
  order.set(userId, next);
}

async function markClaim(
  db: Db,
  id: string,
  status: WaiverClaim['status'],
): Promise<void> {
  await db.query(
    `UPDATE fs_waiver_claim SET status = $2, processed_at = now() WHERE id = $1`,
    [id, status],
  );
}

/**
 * Apply one claim inside a SAVEPOINT so a failed award leaves the roster
 * untouched. Inserts the add (single-owner guard) then deletes exactly the
 * claimant's drop; if the add is taken or the drop is gone, rolls the savepoint
 * back and reports failure (the claim is then marked invalid).
 */
async function tryAward(
  client: PoolClient,
  leagueId: string,
  claim: ClaimRow,
): Promise<boolean> {
  await client.query('SAVEPOINT award');
  try {
    await client.query(
      `INSERT INTO fs_roster_entry
         (league_id, user_id, symbol, is_short, acquired_via)
       VALUES ($1, $2, $3, $4, 'waiver')`,
      [leagueId, claim.user_id, claim.add_symbol, claim.is_short],
    );
    const del = await client.query(
      `DELETE FROM fs_roster_entry
        WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
      [leagueId, claim.user_id, claim.drop_symbol],
    );
    if (del.rowCount !== 1) throw new Error('drop-not-owned');
    await client.query('RELEASE SAVEPOINT award');
    return true;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT award');
    if (isUniqueViolation(err) || (err as Error).message === 'drop-not-owned') {
      return false;
    }
    throw err;
  }
}

/** Resolve one league's pending claims; null when its window is closed. */
async function runLeagueWaivers(
  pool: Pool,
  leagueId: string,
  season: number,
): Promise<{ awarded: number; claims: number } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await windowClosed(client, leagueId, season)) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: pending } = await client.query<ClaimRow>(
      `SELECT ${CLAIM_COLS} FROM fs_waiver_claim
        WHERE league_id = $1 AND season = $2 AND status = 'pending'
        ORDER BY add_symbol, submitted_at`,
      [leagueId, season],
    );
    if (pending.length === 0) {
      await client.query('COMMIT');
      return { awarded: 0, claims: 0 };
    }

    await seedWaiverOrder(client, leagueId, season);
    const order = await loadPriorityMap(client, leagueId, season);
    const pointsFor = await loadPointsFor(client, leagueId, season);

    // Group contested claims by the symbol they're racing for.
    const groups = new Map<string, ClaimRow[]>();
    for (const c of pending) {
      const g = groups.get(c.add_symbol);
      if (g) g.push(c);
      else groups.set(c.add_symbol, [c]);
    }

    let awarded = 0;
    // Deterministic group order; priority is read live so an earlier win this
    // run demotes the same manager for later groups (rolling priority).
    for (const addSymbol of [...groups.keys()].sort()) {
      const claimants = groups.get(addSymbol)!;
      claimants.sort((a, b) => {
        const pa = order.get(a.user_id) ?? Number.MAX_SAFE_INTEGER;
        const pb = order.get(b.user_id) ?? Number.MAX_SAFE_INTEGER;
        if (pa !== pb) return pa - pb; // lower priority claims first
        const fa = pointsFor.get(a.user_id) ?? 0;
        const fb = pointsFor.get(b.user_id) ?? 0;
        if (fa !== fb) return fa - fb; // tiebreak: points-for ascending
        return a.user_id < b.user_id ? -1 : 1;
      });

      let won = false;
      for (const claim of claimants) {
        if (won) {
          await markClaim(client, claim.id, 'lost');
          continue;
        }
        if (await tryAward(client, leagueId, claim)) {
          await markClaim(client, claim.id, 'won');
          await demote(client, leagueId, season, claim.user_id, order);
          awarded += 1;
          won = true;
        } else {
          await markClaim(client, claim.id, 'invalid');
        }
      }
    }

    await client.query('COMMIT');
    return { awarded, claims: pending.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface WaiverRunResult {
  /** Leagues whose window was open and were processed. */
  leagues: number;
  /** Claims awarded across them. */
  awarded: number;
}

/**
 * Run waivers across every active league. Each league is processed in its own
 * transaction; a league whose window is closed (mid-week) is skipped and its
 * claims stay pending. `redis`, when present, receives waiver.processed per
 * processed league with pending claims (after commit).
 */
export async function runWaivers(
  pool: Pool,
  opts: { season?: number } = {},
  redis?: Redis,
): Promise<WaiverRunResult> {
  const season = opts.season ?? 1;
  const { rows: leagues } = await pool.query<{ id: string }>(
    `SELECT id FROM fs_league WHERE status = 'active' ORDER BY id`,
  );

  const result: WaiverRunResult = { leagues: 0, awarded: 0 };
  for (const { id: leagueId } of leagues) {
    const outcome = await runLeagueWaivers(pool, leagueId, season);
    if (outcome === null) continue; // window closed — leave claims pending
    result.leagues += 1;
    result.awarded += outcome.awarded;
    if (redis && outcome.claims > 0) {
      await publishWaiverProcessed(redis, {
        leagueId,
        season,
        awarded: outcome.awarded,
      });
    }
  }
  return result;
}
