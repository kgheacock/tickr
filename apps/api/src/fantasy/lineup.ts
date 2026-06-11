/**
 * Fantasy Street item 04 — weekly lineup orchestration.
 *
 * Pure, pool-driven domain (no Redis, no timers): read/initialize a manager's
 * weekly lineup, validate and persist a set, and auto-fill remaining slots. The
 * Monday-open lock job is the thin shell in lock.ts; the WS/HTTP glue is in
 * routes/leagues/lineup.ts. Everything testable lives here — see
 * test/fantasy/lineup.test.ts.
 *
 * Invariants enforced on every set (DoD):
 *   - each placed symbol is on the caller's fs_roster_entry;
 *   - a non-bench placement is isEligible(symbol, slot);
 *   - Defense holds an is_short entry, every long slot holds a non-short one;
 *   - no symbol is started twice (also DB-guarded by UNIQUE (lineup_id, symbol));
 *   - placements stay within the league roster_config's slot/bench counts;
 *   - a set after the week locks is rejected (409 LINEUP_LOCKED).
 */
import type { Pool, PoolClient } from 'pg';
import type { Lineup, LineupSlot, RosterConfig } from '@tickr/shared-types';
import { FantasyError } from './leagues.js';
import { isEligible } from './eligibility.js';
import { mandatorySlots, autofillLineup, type FilledSlot } from './autofill.js';

const VALID_SLOTS = new Set([
  'anchor',
  'growth',
  'momentum',
  'value',
  'defense',
  'wildcard',
  'bench',
]);

export interface SetLineupInput {
  season?: number;
  week: number;
  slots: { slot: string; slotIndex?: number; symbol: string }[];
}

export interface LineupRow {
  id: string;
  league_id: string;
  user_id: string;
  season: number;
  week: number;
  locked_at: Date | null;
  auto_filled: boolean;
}

interface SlotRow {
  slot: string;
  slot_index: number;
  symbol: string;
  is_short: boolean;
}

// --- Assembly ---------------------------------------------------------------

function toLineupSlot(r: SlotRow): LineupSlot {
  return {
    slot: r.slot as LineupSlot['slot'],
    slotIndex: r.slot_index,
    symbol: r.symbol,
    isShort: r.is_short,
  };
}

async function loadSlots(
  db: Pool | PoolClient,
  lineupId: string,
): Promise<SlotRow[]> {
  const { rows } = await db.query<SlotRow>(
    `SELECT slot, slot_index, symbol, is_short
       FROM fs_lineup_slot WHERE lineup_id = $1
      ORDER BY slot, slot_index`,
    [lineupId],
  );
  return rows;
}

function toLineup(row: LineupRow, slots: SlotRow[]): Lineup {
  return {
    leagueId: row.league_id,
    userId: row.user_id,
    season: row.season,
    week: row.week,
    locked: row.locked_at != null,
    lockedAt: row.locked_at ? row.locked_at.toISOString() : null,
    autoFilled: row.auto_filled,
    slots: slots.map(toLineupSlot),
  };
}

// --- Loaders ----------------------------------------------------------------

export async function loadRosterConfig(
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

/** Find the lineup row, optionally locking it for an update. */
async function loadLineupRow(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
  season: number,
  week: number,
  forUpdate = false,
): Promise<LineupRow | null> {
  const { rows } = await db.query<LineupRow>(
    `SELECT id, league_id, user_id, season, week, locked_at, auto_filled
       FROM fs_lineup
      WHERE league_id = $1 AND user_id = $2 AND season = $3 AND week = $4
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [leagueId, userId, season, week],
  );
  return rows[0] ?? null;
}

/** Insert an empty lineup if none exists; return the (now-present) row. */
export async function ensureLineupRow(
  db: Pool | PoolClient,
  leagueId: string,
  userId: string,
  season: number,
  week: number,
  forUpdate = false,
): Promise<LineupRow> {
  await db.query(
    `INSERT INTO fs_lineup (league_id, user_id, season, week)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (league_id, user_id, season, week) DO NOTHING`,
    [leagueId, userId, season, week],
  );
  const row = await loadLineupRow(
    db,
    leagueId,
    userId,
    season,
    week,
    forUpdate,
  );
  return row!;
}

// --- Get / initialize -------------------------------------------------------

/**
 * The manager's lineup for the week, initializing an empty one if none exists.
 * Carry-forward from the prior week is deferred (FS-06 owns the schedule); an
 * un-set week starts empty and is completed by auto-fill at lock.
 */
export async function getLineup(
  pool: Pool,
  leagueId: string,
  userId: string,
  week: number,
  season = 1,
): Promise<Lineup> {
  assertWeek(week);
  const row = await ensureLineupRow(pool, leagueId, userId, season, week);
  const slots = await loadSlots(pool, row.id);
  return toLineup(row, slots);
}

// --- Validation -------------------------------------------------------------

function assertWeek(week: number): void {
  if (!Number.isInteger(week) || week < 1) {
    throw new FantasyError('VALIDATION', 'week must be a positive integer');
  }
}

/** Per-slot capacity from the roster config (mandatory counts + bench). */
function slotCapacity(cfg: RosterConfig): Map<string, number> {
  const cap = new Map<string, number>();
  for (const { slot } of mandatorySlots(cfg)) {
    cap.set(slot, (cap.get(slot) ?? 0) + 1);
  }
  if (cfg.bench > 0) cap.set('bench', cfg.bench);
  return cap;
}

interface OwnedRow {
  symbol: string;
  is_short: boolean;
}

/** Validate a requested set against ownership, eligibility, and slot rules. */
async function validateSet(
  client: PoolClient,
  leagueId: string,
  userId: string,
  cfg: RosterConfig,
  slots: SetLineupInput['slots'],
): Promise<FilledSlot[]> {
  const capacity = slotCapacity(cfg);
  const { rows: ownedRows } = await client.query<OwnedRow>(
    `SELECT symbol, is_short FROM fs_roster_entry
      WHERE league_id = $1 AND user_id = $2`,
    [leagueId, userId],
  );
  const owned = new Map(ownedRows.map((r) => [r.symbol, r.is_short]));

  const usedPositions = new Set<string>();
  const usedSymbols = new Set<string>();
  const perSlotCount = new Map<string, number>();
  const resolved: FilledSlot[] = [];

  for (const raw of slots) {
    const slot = String(raw.slot).trim().toLowerCase();
    const slotIndex = raw.slotIndex ?? 0;
    const symbol = String(raw.symbol).trim().toUpperCase();

    if (!VALID_SLOTS.has(slot)) {
      throw new FantasyError('VALIDATION', `Unknown slot: ${raw.slot}`);
    }
    const cap = capacity.get(slot) ?? 0;
    if (cap === 0) {
      throw new FantasyError('VALIDATION', `Roster has no ${slot} slot`);
    }
    if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= cap) {
      throw new FantasyError(
        'VALIDATION',
        `slotIndex out of range for ${slot}`,
      );
    }
    const posKey = `${slot}#${slotIndex}`;
    if (usedPositions.has(posKey)) {
      throw new FantasyError('VALIDATION', `Duplicate placement for ${posKey}`);
    }
    usedPositions.add(posKey);
    perSlotCount.set(slot, (perSlotCount.get(slot) ?? 0) + 1);

    if (!owned.has(symbol)) {
      throw new FantasyError('VALIDATION', `${symbol} is not on your roster`);
    }
    if (usedSymbols.has(symbol)) {
      throw new FantasyError('VALIDATION', `${symbol} is started twice`);
    }
    usedSymbols.add(symbol);
    const isShort = owned.get(symbol)!;

    // Bench accepts any owned symbol; mandatory slots enforce eligibility +
    // the short/long rule (Defense short-only, long slots non-short only).
    if (slot !== 'bench') {
      if (slot === 'defense' && !isShort) {
        throw new FantasyError(
          'VALIDATION',
          `${symbol} is a long; Defense holds a short`,
        );
      }
      if (slot !== 'defense' && isShort) {
        throw new FantasyError(
          'VALIDATION',
          `${symbol} is a short; ${slot} holds a long`,
        );
      }
      if (!(await isEligible(client, symbol, slot))) {
        throw new FantasyError(
          'VALIDATION',
          `${symbol} is not eligible for ${slot}`,
        );
      }
    }
    resolved.push({ slot, slotIndex, symbol, isShort });
  }
  return resolved;
}

// --- Set --------------------------------------------------------------------

/** Replace the slots written to a lineup (full rewrite within a txn). */
async function writeSlots(
  client: PoolClient,
  lineupId: string,
  slots: FilledSlot[],
): Promise<void> {
  await client.query(`DELETE FROM fs_lineup_slot WHERE lineup_id = $1`, [
    lineupId,
  ]);
  for (const s of slots) {
    await client.query(
      `INSERT INTO fs_lineup_slot (lineup_id, slot, slot_index, symbol, is_short)
       VALUES ($1, $2, $3, $4, $5)`,
      [lineupId, s.slot, s.slotIndex, s.symbol, s.isShort],
    );
  }
}

/**
 * Set the manager's lineup for the week. Validates ownership/eligibility/slot
 * rules, rejects a locked week (409 LINEUP_LOCKED), then rewrites the started
 * set. A partial set is allowed — auto-fill (explicit or at lock) completes it.
 */
export async function setLineup(
  pool: Pool,
  leagueId: string,
  userId: string,
  input: SetLineupInput,
): Promise<Lineup> {
  assertWeek(input.week);
  const season = input.season ?? 1;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfg = await loadRosterConfig(client, leagueId);
    const row = await ensureLineupRow(
      client,
      leagueId,
      userId,
      season,
      input.week,
      true,
    );
    if (row.locked_at != null) {
      throw new FantasyError('LINEUP_LOCKED', 'Lineup is locked for this week');
    }
    const resolved = await validateSet(
      client,
      leagueId,
      userId,
      cfg,
      input.slots,
    );
    await writeSlots(client, row.id, resolved);
    await client.query(
      `UPDATE fs_lineup SET updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getLineup(pool, leagueId, userId, input.week, season);
}

// --- Auto-fill remaining ----------------------------------------------------

/**
 * Fill the manager's empty mandatory slots with their best eligible roster
 * options, without locking. Returns the resulting lineup; sets `auto_filled`
 * when it added anything. Shared with the lock job (lock.ts).
 */
export async function autofillRemaining(
  pool: Pool,
  leagueId: string,
  userId: string,
  week: number,
  season = 1,
): Promise<Lineup> {
  assertWeek(week);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cfg = await loadRosterConfig(client, leagueId);
    const row = await ensureLineupRow(
      client,
      leagueId,
      userId,
      season,
      week,
      true,
    );
    if (row.locked_at != null) {
      throw new FantasyError('LINEUP_LOCKED', 'Lineup is locked for this week');
    }
    const added = await fillAndPersist(client, row.id, leagueId, userId, cfg);
    if (added > 0) {
      await client.query(
        `UPDATE fs_lineup SET auto_filled = true, updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return getLineup(pool, leagueId, userId, week, season);
}

/**
 * Compute and insert auto-fill slots for an already-loaded lineup row, returning
 * how many were added. Caller owns the transaction and the lock-state stamp;
 * used by autofillRemaining and the lock job.
 */
export async function fillAndPersist(
  client: PoolClient,
  lineupId: string,
  leagueId: string,
  userId: string,
  cfg: RosterConfig,
): Promise<number> {
  const existing = await loadSlots(client, lineupId);
  const fills = await autofillLineup(
    client,
    leagueId,
    userId,
    cfg,
    existing.map((s) => ({
      slot: s.slot,
      slotIndex: s.slot_index,
      symbol: s.symbol,
    })),
  );
  for (const f of fills) {
    await client.query(
      `INSERT INTO fs_lineup_slot (lineup_id, slot, slot_index, symbol, is_short)
       VALUES ($1, $2, $3, $4, $5)`,
      [lineupId, f.slot, f.slotIndex, f.symbol, f.isShort],
    );
  }
  return fills.length;
}
