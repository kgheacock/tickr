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
import { mergedCloseSql, mergedDailySeriesSql } from '../../fantasy/closes.js';
import {
  currentWeek,
  recentCompletedWeeks,
  returnPctFrom,
  weeklyReturn,
} from '../../fantasy/returns.js';
import { slotPoints } from '../../fantasy/score.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Weeks of per-stock scoring surfaced in the detail "previous scoring" panel. */
const SCORING_HISTORY_WEEKS = 8;
/** Completed weeks spanned by the trailing 3-month scoring summary (~13 weeks). */
const SCORING_SUMMARY_WEEKS = 13;

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

  // "Points this week" is the in-flight week's return so far: the move from last
  // Friday's regular close (baseline) to the latest available close (asOf = now),
  // matching the provisional scorer's weeklyReturn(asOf = now) — so the column
  // agrees with the team's in-progress total (score.ts) and the detail view's
  // provisional scoringHistory[0].
  const now = opts.now ?? new Date();
  const { baselineAt } = currentWeek(now);
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
                  ${mergedCloseSql('us.symbol', `$${n + 1}`)} AS base_close,
                  ${mergedCloseSql('us.symbol', `$${n + 2}`)} AS this_close
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
         SELECT page.*,
                ${mergedCloseSql('page.symbol', `$${n + 3}`)} AS base_close,
                ${mergedCloseSql('page.symbol', `$${n + 4}`)} AS this_close
           FROM page
          ORDER BY page.symbol ${dir}`;

  const queryParams =
    sort === 'lastWk'
      ? [...params, baselineAt, now, limit, offset]
      : [...params, limit, offset, baselineAt, now];

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
        currentWeekPoints: lastWeekPoints(returnPctFrom(base, cur)),
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

  // The detail-view price chart: the merged DAILY series (closes.ts) over a
  // ~3-month window — 15-min price_bar collapsed to one regular-session bar per
  // ET trading day, with the close overlaid by the official session_close so the
  // chart's latest close matches the scored close. OHL is null only for a
  // session_close-only day (not yet in price_bar); coalesced to close below.
  const { rows: bars } = await db.query<{
    ts: Date;
    open: number | null;
    high: number | null;
    low: number | null;
    close: number;
    volume: number | null;
  }>(mergedDailySeriesSql('$1', "($2::timestamptz - interval '3 months')"), [
    sym,
    now.toISOString(),
  ]);

  // Previous scoring: the per-week long-basis points, most recent first. The
  // in-flight entry below ([0], provisional) shares its anchors with the
  // inventory's currentWeekPoints, so the two surfaces agree (returns.ts). The
  // week's Monday is the Friday anchor back four days — the chart labels weeks by
  // their close, but the ledger reads as "week starting".
  const weekRow = (
    w: { weekEnd: Date },
    r: { returnPct: number | null },
    provisional: boolean,
  ) => ({
    weekStart: new Date(w.weekEnd.getTime() - 4 * 86_400_000).toISOString(),
    weekEnd: w.weekEnd.toISOString(),
    returnPct: r.returnPct == null ? null : Math.round(r.returnPct * 100) / 100,
    points: lastWeekPoints(r.returnPct),
    provisional,
  });

  const scoringHistory = [];
  // The in-flight week first, valued "so far" off the latest available close
  // (asOf = now), flagged provisional so the UI can mark it as still open.
  const cur = currentWeek(now);
  const curR = await weeklyReturn(db, sym, cur.weekEnd, now, cur.baselineAt);
  scoringHistory.push(weekRow(cur, curR, true));

  // Walk the trailing ~3 months of completed weeks once: the first
  // SCORING_HISTORY_WEEKS feed the detail table, the whole span feeds the
  // 3-month scoring summary below.
  const completedPoints: number[] = [];
  const completed = recentCompletedWeeks(now, SCORING_SUMMARY_WEEKS);
  for (let i = 0; i < completed.length; i++) {
    const w = completed[i]!;
    const r = await weeklyReturn(db, sym, w.weekEnd, w.weekEnd, w.baselineAt);
    const pts = lastWeekPoints(r.returnPct);
    if (pts != null) completedPoints.push(pts);
    if (i < SCORING_HISTORY_WEEKS) scoringHistory.push(weekRow(w, r, false));
  }

  // 3-month scoring summary: total long-basis points and the share of scored
  // weeks that finished positive. Weeks with no resolvable price data are dropped.
  const scoring3mo = {
    totalPoints: completedPoints.length
      ? Math.round(completedPoints.reduce((a, b) => a + b, 0) * 100) / 100
      : null,
    pctPositive: completedPoints.length
      ? Math.round(
          (completedPoints.filter((p) => p > 0).length /
            completedPoints.length) *
            100,
        )
      : null,
    weeks: completedPoints.length,
  };

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
    scoring3mo,
    prices: bars.map((b) => {
      // A session_close-only day has no intraday OHL; collapse the candle to the
      // close so PriceBar's non-null open/high/low hold.
      const close = b.close;
      return {
        ts: b.ts.toISOString(),
        open: b.open ?? close,
        high: b.high ?? close,
        low: b.low ?? close,
        close,
        volume: b.volume,
      };
    }),
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
