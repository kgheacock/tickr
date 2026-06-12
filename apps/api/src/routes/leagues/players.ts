/**
 * Fantasy Street item 02 — player (stock) inventory + detail, league-scoped so
 * ownership is correct per league.
 *   GET /leagues/:id/players          paginated inventory (?group, ?available, ?q)
 *   GET /leagues/:id/players/:symbol  detail view (classification, prices, slots)
 *
 * Read-only over the corpus (universe_symbol + price_bar) joined with the
 * classifier output (fs_player_classification) and per-league ownership
 * (fs_roster_entry). Query helpers are exported for direct testing.
 */
import type { FastifyInstance } from 'fastify';
import type {
  PlayerDetail,
  PlayerGroup,
  PlayerInventoryItem,
  PlayerListResponse,
  PlayerMetrics,
} from '@tickr/shared-types';
import type { Pool } from 'pg';
import { pool } from '../../db/pool.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import { slotsFor } from '../../fantasy/eligibility.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface InventoryOptions {
  group?: string | undefined;
  available?: boolean | undefined;
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  /** Restrict to the caller's owned players (their roster); needs `userId`. */
  mine?: boolean | undefined;
  /** The caller, when `mine` is set. Ownership is exclusive per ticker. */
  userId?: string | undefined;
}

interface OwnershipCols {
  owned: boolean;
  owner_team: string | null;
  is_short: boolean | null;
}

function ownershipOf(r: OwnershipCols): PlayerInventoryItem['ownership'] {
  return r.owned
    ? { owned: true, ownerTeam: r.owner_team, isShort: r.is_short }
    : { owned: false, ownerTeam: null, isShort: null };
}

function metricsOf(raw: Record<string, unknown> | null): PlayerMetrics {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    ret3mPct: num(raw?.['ret3mPct']),
    ret12mPct: num(raw?.['ret12mPct']),
    sigma: num(raw?.['sigma']),
    avgVolume: num(raw?.['avgVolume']),
  };
}

export async function listPlayers(
  db: Pool,
  leagueId: string,
  opts: InventoryOptions = {},
): Promise<PlayerListResponse> {
  const limit = Math.min(
    Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)),
    MAX_LIMIT,
  );
  const offset = Math.max(0, Math.trunc(opts.offset ?? 0));

  // $1 league id is always present; later filters append.
  const params: unknown[] = [leagueId];
  const filters: string[] = [];
  if (opts.group) {
    params.push(opts.group);
    filters.push(`$${params.length} = ANY(cls.groups)`);
  }
  if (opts.available) {
    filters.push(`re.symbol IS NULL`);
  }
  // The caller's roster: ownership is exclusive per ticker, so the owner row is
  // unique — filtering re.user_id yields exactly the symbols this manager holds.
  if (opts.mine && opts.userId) {
    params.push(opts.userId);
    filters.push(`re.user_id = $${params.length}`);
  }
  if (opts.q) {
    params.push(`${opts.q.toUpperCase()}%`);
    filters.push(`us.symbol LIKE $${params.length}`);
  }
  const filterSql = filters.length ? `AND ${filters.join(' AND ')}` : '';

  const fromSql = `
    FROM universe_symbol us
    LEFT JOIN (
      SELECT symbol,
             array_agg("group" ORDER BY "group") AS groups,
             (array_agg(metrics ORDER BY "group"))[1] AS metrics
        FROM fs_player_classification
       WHERE eligible
       GROUP BY symbol
    ) cls ON cls.symbol = us.symbol
    LEFT JOIN fs_roster_entry re
           ON re.symbol = us.symbol AND re.league_id = $1
    LEFT JOIN fs_league_member lm
           ON lm.league_id = re.league_id AND lm.user_id = re.user_id
   WHERE us.removed_at IS NULL
     AND us.backfilled = true
     AND us.data_status IS DISTINCT FROM 'incomplete'
     ${filterSql}`;

  const { rows: countRows } = await db.query<{ count: string }>(
    `SELECT count(*)::int AS count ${fromSql}`,
    params,
  );
  const total = Number(countRows[0]!.count);

  const { rows } = await db.query<
    OwnershipCols & {
      symbol: string;
      groups: PlayerGroup[] | null;
      metrics: Record<string, unknown> | null;
    }
  >(
    `SELECT us.symbol,
            cls.groups AS groups,
            cls.metrics AS metrics,
            (re.symbol IS NOT NULL) AS owned,
            lm.team_name AS owner_team,
            re.is_short AS is_short
       ${fromSql}
      ORDER BY us.symbol
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  return {
    items: rows.map((r) => ({
      symbol: r.symbol,
      groups: r.groups ?? [],
      recentReturnPct: metricsOf(r.metrics).ret3mPct,
      ownership: ownershipOf(r),
    })),
    total,
    limit,
    offset,
  };
}

export async function getPlayerDetail(
  db: Pool,
  leagueId: string,
  symbol: string,
): Promise<PlayerDetail | null> {
  const sym = symbol.toUpperCase();
  const { rows: head } = await db.query<
    OwnershipCols & {
      groups: PlayerGroup[] | null;
      metrics: Record<string, unknown> | null;
    }
  >(
    `SELECT cls.groups AS groups,
            cls.metrics AS metrics,
            (re.symbol IS NOT NULL) AS owned,
            lm.team_name AS owner_team,
            re.is_short AS is_short
       FROM universe_symbol us
       LEFT JOIN (
         SELECT symbol,
                array_agg("group" ORDER BY "group") AS groups,
                (array_agg(metrics ORDER BY "group"))[1] AS metrics
           FROM fs_player_classification
          WHERE eligible
          GROUP BY symbol
       ) cls ON cls.symbol = us.symbol
       LEFT JOIN fs_roster_entry re
              ON re.symbol = us.symbol AND re.league_id = $2
       LEFT JOIN fs_league_member lm
              ON lm.league_id = re.league_id AND lm.user_id = re.user_id
      WHERE us.symbol = $1
        AND us.removed_at IS NULL`,
    [sym, leagueId],
  );
  if (head.length === 0) return null;
  const h = head[0]!;

  const { rows: bars } = await db.query<{
    ts: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number | null;
  }>(
    `SELECT ts, open, high, low, close, volume
       FROM price_bar
      WHERE symbol = $1 AND ts >= now() - interval '1 year'
      ORDER BY ts ASC`,
    [sym],
  );

  const metrics = metricsOf(h.metrics);
  return {
    symbol: sym,
    groups: h.groups ?? [],
    eligibleSlots: await slotsFor(db, sym),
    recentReturnPct: metrics.ret3mPct,
    metrics,
    ownership: ownershipOf(h),
    prices: bars.map((b) => ({
      ts: b.ts.toISOString(),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
  };
}

export function registerPlayersRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { id: string };
    Querystring: {
      group?: string;
      available?: string;
      q?: string;
      limit?: string;
      offset?: string;
      mine?: string;
    };
  }>('/leagues/:id/players', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const { group, available, q, limit, offset, mine } = req.query;
    return listPlayers(pool, req.params.id, {
      group,
      available: available === 'true',
      q,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
      mine: mine === 'true',
      userId: req.userId!,
    });
  });

  fastify.get<{ Params: { id: string; symbol: string } }>(
    '/leagues/:id/players/:symbol',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      const detail = await getPlayerDetail(
        pool,
        req.params.id,
        req.params.symbol,
      );
      if (!detail) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Player not found' } });
      }
      return detail;
    },
  );
}
