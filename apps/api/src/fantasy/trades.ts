/**
 * Fantasy Street item 07 — manager-to-manager trades.
 *
 * A proposer offers some of their owned tickers (`give`) for some of a target's
 * (`receive`). On accept, ownership is **re-keyed in place** — each
 * fs_roster_entry row's user_id flips to the other party in one transaction — so
 * UNIQUE (league_id, symbol) holds throughout (one row per symbol the whole
 * time, never a delete+insert hole). Every leg is re-validated at accept: a leg
 * whose ownership has moved since the proposal makes the accept stale (409).
 *
 * Acceptance is a real-time roster mutation, so it is gated by the unlocked
 * window (assertWindowOpen) — a locked, unsettled week rejects it. Proposing,
 * rejecting and cancelling are lifecycle-only and never touch the roster.
 *
 * See TODO/fantasy-street/07-waivers-and-trades.md and test/fantasy/trades.test.ts.
 */
import type { Pool, PoolClient } from 'pg';
import type { Trade, TradeItem } from '@tickr/shared-types';
import { FantasyError } from './leagues.js';
import { assertWindowOpen } from './waivers.js';

interface TradeRow {
  id: string;
  league_id: string;
  proposer_user_id: string;
  target_user_id: string;
  status: Trade['status'];
  created_at: Date;
  resolved_at: Date | null;
}

interface ItemRow {
  trade_id: string;
  from_user_id: string;
  symbol: string;
  is_short: boolean;
}

const TRADE_COLS = `id, league_id, proposer_user_id, target_user_id, status,
        created_at, resolved_at`;

function toItem(r: ItemRow): TradeItem {
  return {
    fromUserId: r.from_user_id,
    symbol: r.symbol,
    isShort: r.is_short,
  };
}

function toTrade(r: TradeRow, items: ItemRow[]): Trade {
  return {
    id: r.id,
    leagueId: r.league_id,
    proposerUserId: r.proposer_user_id,
    targetUserId: r.target_user_id,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    items: items.map(toItem),
  };
}

async function loadTrade(
  db: Pool | PoolClient,
  tradeId: string,
  forUpdate = false,
): Promise<{ trade: TradeRow; items: ItemRow[] } | null> {
  const { rows } = await db.query<TradeRow>(
    `SELECT ${TRADE_COLS} FROM fs_trade WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [tradeId],
  );
  const trade = rows[0];
  if (!trade) return null;
  const { rows: items } = await db.query<ItemRow>(
    `SELECT trade_id, from_user_id, symbol, is_short
       FROM fs_trade_item WHERE trade_id = $1 ORDER BY symbol`,
    [tradeId],
  );
  return { trade, items };
}

// --- Propose ---------------------------------------------------------------

export interface ProposeTradeInput {
  targetUserId: string;
  give: string[];
  receive: string[];
}

/**
 * Propose a trade. Validates the target is a distinct league member, the give
 * legs are all the proposer's and the receive legs all the target's, and the two
 * sides are disjoint and non-empty — then writes a `proposed` trade with its
 * legs. No roster change yet; ownership only moves on accept.
 */
export async function proposeTrade(
  pool: Pool,
  leagueId: string,
  proposerUserId: string,
  input: ProposeTradeInput,
): Promise<Trade> {
  const targetUserId = input.targetUserId?.trim();
  if (!targetUserId) {
    throw new FantasyError('VALIDATION', 'targetUserId is required');
  }
  if (targetUserId === proposerUserId) {
    throw new FantasyError('VALIDATION', 'Cannot trade with yourself');
  }
  const give = normalizeLegs(input.give, 'give');
  const receive = normalizeLegs(input.receive, 'receive');
  if (give.length === 0 && receive.length === 0) {
    throw new FantasyError(
      'VALIDATION',
      'A trade must move at least one symbol',
    );
  }
  for (const s of give) {
    if (receive.includes(s)) {
      throw new FantasyError(
        'VALIDATION',
        `${s} is on both sides of the trade`,
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const target = await client.query(
      `SELECT 1 FROM fs_league_member WHERE league_id = $1 AND user_id = $2`,
      [leagueId, targetUserId],
    );
    if (!target.rowCount) {
      throw new FantasyError('NOT_FOUND', 'Target is not a league member');
    }

    await assertOwnsAll(client, leagueId, proposerUserId, give, 'give');
    await assertOwnsAll(client, leagueId, targetUserId, receive, 'receive');

    const { rows } = await client.query<TradeRow>(
      `INSERT INTO fs_trade (league_id, proposer_user_id, target_user_id)
       VALUES ($1, $2, $3)
       RETURNING ${TRADE_COLS}`,
      [leagueId, proposerUserId, targetUserId],
    );
    const trade = rows[0]!;

    // Persist each leg with the side it currently moves from, carrying is_short
    // so the position keeps its long/short sense after the swap.
    for (const symbol of give) {
      await insertItem(client, trade.id, leagueId, proposerUserId, symbol);
    }
    for (const symbol of receive) {
      await insertItem(client, trade.id, leagueId, targetUserId, symbol);
    }

    await client.query('COMMIT');
    const loaded = await loadTrade(pool, trade.id);
    return toTrade(loaded!.trade, loaded!.items);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function normalizeLegs(raw: string[] | undefined, label: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw new FantasyError(
      'VALIDATION',
      `${label} must be an array of symbols`,
    );
  }
  const out: string[] = [];
  for (const s of raw) {
    const sym = typeof s === 'string' ? s.trim().toUpperCase() : '';
    if (!sym)
      throw new FantasyError('VALIDATION', `${label} has an empty symbol`);
    if (out.includes(sym)) {
      throw new FantasyError('VALIDATION', `${label} repeats ${sym}`);
    }
    out.push(sym);
  }
  return out;
}

async function assertOwnsAll(
  db: PoolClient,
  leagueId: string,
  userId: string,
  symbols: string[],
  label: string,
): Promise<void> {
  for (const symbol of symbols) {
    const { rowCount } = await db.query(
      `SELECT 1 FROM fs_roster_entry
        WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
      [leagueId, userId, symbol],
    );
    if (!rowCount) {
      throw new FantasyError(
        'VALIDATION',
        `${label} symbol ${symbol} is not owned by its side`,
      );
    }
  }
}

async function insertItem(
  db: PoolClient,
  tradeId: string,
  leagueId: string,
  fromUserId: string,
  symbol: string,
): Promise<void> {
  const { rows } = await db.query<{ is_short: boolean }>(
    `SELECT is_short FROM fs_roster_entry
      WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
    [leagueId, fromUserId, symbol],
  );
  await db.query(
    `INSERT INTO fs_trade_item (trade_id, from_user_id, symbol, is_short)
     VALUES ($1, $2, $3, $4)`,
    [tradeId, fromUserId, symbol, rows[0]?.is_short ?? false],
  );
}

// --- Respond (accept / reject / cancel) ------------------------------------

export type TradeAction = 'accept' | 'reject' | 'cancel';

/**
 * Resolve a proposed trade. `accept`/`reject` are the target's; `cancel` is the
 * proposer's. Accepting swaps ownership atomically inside the unlocked window;
 * a leg that has since moved makes the accept stale (409). Returns the updated
 * trade. The caller publishes trade.accepted when status flips to `accepted`.
 */
export async function respondToTrade(
  pool: Pool,
  leagueId: string,
  tradeId: string,
  userId: string,
  action: TradeAction,
  season = 1,
): Promise<Trade> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const loaded = await loadTrade(client, tradeId, true);
    if (!loaded || loaded.trade.league_id !== leagueId) {
      throw new FantasyError('NOT_FOUND', 'Trade not found');
    }
    const { trade, items } = loaded;
    if (trade.status !== 'proposed') {
      throw new FantasyError('CONFLICT', `Trade is already ${trade.status}`);
    }

    if (action === 'cancel') {
      if (userId !== trade.proposer_user_id) {
        throw new FantasyError('FORBIDDEN', 'Only the proposer can cancel');
      }
      await setStatus(client, tradeId, 'cancelled');
    } else {
      // accept / reject are the target's call.
      if (userId !== trade.target_user_id) {
        throw new FantasyError('FORBIDDEN', 'Only the target can respond');
      }
      if (action === 'reject') {
        await setStatus(client, tradeId, 'rejected');
      } else {
        await assertWindowOpen(client, leagueId, season);
        await applySwap(client, leagueId, trade, items);
        await setStatus(client, tradeId, 'accepted');
      }
    }

    await client.query('COMMIT');
    const after = await loadTrade(pool, tradeId);
    return toTrade(after!.trade, after!.items);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Re-key each leg's ownership to the other party; a moved leg → stale (409). */
async function applySwap(
  db: PoolClient,
  leagueId: string,
  trade: TradeRow,
  items: ItemRow[],
): Promise<void> {
  for (const it of items) {
    const toUser =
      it.from_user_id === trade.proposer_user_id
        ? trade.target_user_id
        : trade.proposer_user_id;
    const { rowCount } = await db.query(
      `UPDATE fs_roster_entry
          SET user_id = $4, acquired_via = 'trade', acquired_at = now()
        WHERE league_id = $1 AND user_id = $2 AND symbol = $3`,
      [leagueId, it.from_user_id, it.symbol, toUser],
    );
    if (rowCount !== 1) {
      throw new FantasyError(
        'CONFLICT',
        `Trade leg ${it.symbol} has moved; the proposal is no longer valid`,
      );
    }
  }
}

async function setStatus(
  db: PoolClient,
  tradeId: string,
  status: Trade['status'],
): Promise<void> {
  await db.query(
    `UPDATE fs_trade SET status = $2, resolved_at = now() WHERE id = $1`,
    [tradeId, status],
  );
}

// --- Read -------------------------------------------------------------------

export interface TradesView {
  incoming: Trade[];
  outgoing: Trade[];
}

/** A manager's trades: incoming (they're the target), outgoing (the proposer). */
export async function listTrades(
  pool: Pool,
  leagueId: string,
  userId: string,
): Promise<TradesView> {
  const { rows } = await pool.query<TradeRow>(
    `SELECT ${TRADE_COLS} FROM fs_trade
      WHERE league_id = $1 AND (proposer_user_id = $2 OR target_user_id = $2)
      ORDER BY created_at DESC`,
    [leagueId, userId],
  );
  if (rows.length === 0) return { incoming: [], outgoing: [] };

  const { rows: allItems } = await pool.query<ItemRow>(
    `SELECT trade_id, from_user_id, symbol, is_short
       FROM fs_trade_item
      WHERE trade_id = ANY($1::uuid[])
      ORDER BY symbol`,
    [rows.map((r) => r.id)],
  );
  const byTrade = new Map<string, ItemRow[]>();
  for (const it of allItems) {
    const g = byTrade.get(it.trade_id);
    if (g) g.push(it);
    else byTrade.set(it.trade_id, [it]);
  }

  const incoming: Trade[] = [];
  const outgoing: Trade[] = [];
  for (const r of rows) {
    const trade = toTrade(r, byTrade.get(r.id) ?? []);
    if (r.target_user_id === userId) incoming.push(trade);
    else outgoing.push(trade);
  }
  return { incoming, outgoing };
}
