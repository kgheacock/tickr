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
import {
  lastCompletedWeek,
  recentCompletedWeeks,
  returnPctFrom,
  weeklyReturn,
} from '../../fantasy/returns.js';
import { slotPoints } from '../../fantasy/score.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Weeks of per-stock scoring surfaced in the detail "previous scoring" panel. */
const SCORING_HISTORY_WEEKS = 8;

/** "Points last week" for a stock, long basis (r); null when no return. */
function lastWeekPoints(returnPct: number | null): number | null {
  return returnPct == null ? null : slotPoints(returnPct, false);
}

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
  /** Sort column; defaults to `symbol`. `lastWk` orders by the weekly move. */
  sort?: InventorySort | undefined;
  /** Sort direction; defaults to `asc`. */
  dir?: 'asc' | 'desc' | undefined;
  /** Clock for the "last completed week" anchors; defaults to now (testing). */
  now?: Date | undefined;
}

/** Columns the inventory listing can be ordered by. */
export type InventorySort = 'symbol' | 'lastWk';

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
    LEFT JOIN symbol_metadata sm ON sm.symbol = us.symbol
   WHERE us.removed_at IS NULL
     AND us.backfilled = true
     AND us.data_status IS DISTINCT FROM 'incomplete'
     ${filterSql}`;

  const { rows: countRows } = await db.query<{ count: string }>(
    `SELECT count(*)::int AS count ${fromSql}`,
    params,
  );
  const total = Number(countRows[0]!.count);

  // "Points last week" is the most-recently-completed week's return, valued
  // off the same regular-close anchors the Friday settle uses (returns.ts).
  const { weekEnd, baselineAt } = lastCompletedWeek(opts.now ?? new Date());
  const n = params.length;
  const sort: InventorySort = opts.sort === 'lastWk' ? 'lastWk' : 'symbol';
  const dir = opts.dir === 'desc' ? 'DESC' : 'ASC';

  // Two shapes by sort column:
  //   • symbol — page first (ORDER BY/LIMIT in the inner CTE), then look up the
  //     two closes for just that page; the cost stays bounded to one page.
  //   • lastWk — the weekly move isn't known until the closes are read, so they
  //     must be computed over the *whole* filtered set before ordering + paging.
  //     Ordering by the close ratio matches ordering by the long-basis points,
  //     which are monotonic in the return, so no scoring needs to run in SQL.
  const sql =
    sort === 'lastWk'
      ? `WITH scored AS (
           SELECT us.symbol,
                  sm.name AS name,
                  cls.groups AS groups,
                  cls.metrics AS metrics,
                  (re.symbol IS NOT NULL) AS owned,
                  lm.team_name AS owner_team,
                  re.is_short AS is_short,
                  (SELECT close FROM price_bar
                    WHERE symbol = us.symbol AND ts <= $${n + 1}
                    ORDER BY ts DESC LIMIT 1) AS base_close,
                  (SELECT close FROM price_bar
                    WHERE symbol = us.symbol AND ts <= $${n + 2}
                    ORDER BY ts DESC LIMIT 1) AS this_close
             ${fromSql}
         )
         SELECT * FROM scored
          ORDER BY (this_close::numeric / NULLIF(base_close, 0)) ${dir} NULLS LAST,
                   symbol ASC
          LIMIT $${n + 3} OFFSET $${n + 4}`
      : `WITH page AS (
           SELECT us.symbol,
                  sm.name AS name,
                  cls.groups AS groups,
                  cls.metrics AS metrics,
                  (re.symbol IS NOT NULL) AS owned,
                  lm.team_name AS owner_team,
                  re.is_short AS is_short
             ${fromSql}
            ORDER BY us.symbol ${dir}
            LIMIT $${n + 1} OFFSET $${n + 2}
         )
         SELECT page.*, base.close AS base_close, cur.close AS this_close
           FROM page
           LEFT JOIN LATERAL (
             SELECT close FROM price_bar
              WHERE symbol = page.symbol AND ts <= $${n + 3}
              ORDER BY ts DESC LIMIT 1
           ) base ON true
           LEFT JOIN LATERAL (
             SELECT close FROM price_bar
              WHERE symbol = page.symbol AND ts <= $${n + 4}
              ORDER BY ts DESC LIMIT 1
           ) cur ON true
          ORDER BY page.symbol ${dir}`;

  const queryParams =
    sort === 'lastWk'
      ? [...params, baselineAt, weekEnd, limit, offset]
      : [...params, limit, offset, baselineAt, weekEnd];

  const { rows } = await db.query<
    OwnershipCols & {
      symbol: string;
      name: string | null;
      groups: PlayerGroup[] | null;
      metrics: Record<string, unknown> | null;
      base_close: string | number | null;
      this_close: string | number | null;
    }
  >(sql, queryParams);

  return {
    items: rows.map((r) => {
      const base = r.base_close == null ? null : Number(r.base_close);
      const cur = r.this_close == null ? null : Number(r.this_close);
      return {
        symbol: r.symbol,
        name: r.name ?? null,
        groups: r.groups ?? [],
        recentReturnPct: metricsOf(r.metrics).ret3mPct,
        lastWeekPoints: lastWeekPoints(returnPctFrom(base, cur)),
        ownership: ownershipOf(r),
      };
    }),
    total,
    limit,
    offset,
  };
}

export async function getPlayerDetail(
  db: Pool,
  leagueId: string,
  symbol: string,
  now: Date = new Date(),
): Promise<PlayerDetail | null> {
  const sym = symbol.toUpperCase();
  const { rows: head } = await db.query<
    OwnershipCols & {
      name: string | null;
      groups: PlayerGroup[] | null;
      metrics: Record<string, unknown> | null;
    }
  >(
    `SELECT sm.name AS name,
            cls.groups AS groups,
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
       LEFT JOIN symbol_metadata sm ON sm.symbol = us.symbol
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
      WHERE symbol = $1 AND ts >= $2::timestamptz - interval '3 months'
      ORDER BY ts ASC`,
    [sym, now.toISOString()],
  );

  // Previous scoring: the per-week long-basis points for the last several
  // completed weeks (most recent first). The newest entry shares its anchors
  // with the inventory's lastWeekPoints, so the two columns agree (returns.ts).
  const scoringHistory = [];
  for (const w of recentCompletedWeeks(now, SCORING_HISTORY_WEEKS)) {
    const r = await weeklyReturn(db, sym, w.weekEnd, w.weekEnd, w.baselineAt);
    scoringHistory.push({
      weekEnd: w.weekEnd.toISOString(),
      returnPct:
        r.returnPct == null ? null : Math.round(r.returnPct * 100) / 100,
      points: lastWeekPoints(r.returnPct),
    });
  }

  const metrics = metricsOf(h.metrics);
  return {
    symbol: sym,
    name: h.name ?? null,
    groups: h.groups ?? [],
    eligibleSlots: await slotsFor(db, sym),
    recentReturnPct: metrics.ret3mPct,
    metrics,
    ownership: ownershipOf(h),
    scoringHistory,
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
      sort?: string;
      dir?: string;
    };
  }>('/leagues/:id/players', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const { group, available, q, limit, offset, mine, sort, dir } = req.query;
    return listPlayers(pool, req.params.id, {
      group,
      available: available === 'true',
      q,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
      mine: mine === 'true',
      sort: sort === 'lastWk' ? 'lastWk' : undefined,
      dir: dir === 'desc' ? 'desc' : undefined,
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
