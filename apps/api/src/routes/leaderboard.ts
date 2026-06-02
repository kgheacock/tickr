import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { getRedis } from '../redis.js';
import {
  readLeaderboardCache,
  writeLeaderboardCache,
  TOP_N,
} from '../cache/leaderboard.js';
import { decodeCursor, encodeCursor } from '../jobs/snapshot.js';
import type {
  LeaderboardResponse,
  LeaderboardRowItem,
} from '@tickr/shared-types';

const DEFAULT_LIMIT = 50;

export async function registerLeaderboardRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{
    Querystring: { limit?: string; cursor?: string };
  }>('/leaderboard', async (req, reply) => {
    const limit = Math.min(
      Math.max(
        1,
        parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT,
      ),
      200,
    );
    const cursor = req.query.cursor;
    const redis = getRedis();

    // Fast path: first page served from Redis cache.
    if (!cursor) {
      const cached = await readLeaderboardCache(redis);
      if (cached) {
        if (limit >= cached.rows.length) {
          return cached;
        }
        return {
          takenAt: cached.takenAt,
          rows: cached.rows.slice(0, limit),
          nextCursor:
            cached.rows.length > limit
              ? encodeCursor({
                  rank: cached.rows[limit - 1]!.rank,
                  portfolio_id: cached.rows[limit - 1]!.portfolioId,
                })
              : null,
        } satisfies LeaderboardResponse;
      }
    }

    // Cache miss or paginated request: query leaderboard_row.
    const { rows: atRows } = await pool.query<{ taken_at: Date }>(
      `SELECT taken_at FROM leaderboard_row ORDER BY taken_at DESC LIMIT 1`,
    );

    if (!atRows[0]) {
      return reply.code(404).send({
        error: { code: 'NO_SNAPSHOT', message: 'No snapshot available yet' },
      });
    }

    const takenAt = atRows[0].taken_at.toISOString();

    let cursorFilter = '';
    const params: unknown[] = [takenAt, limit + 1];
    if (cursor) {
      const { rank, portfolioId } = decodeCursor(cursor);
      cursorFilter = `AND (lr.rank, lr.portfolio_id::text) > ($3, $4)`;
      params.push(rank, portfolioId);
    }

    const { rows } = await pool.query<{
      rank: number;
      portfolio_id: string;
      display_name: string;
      is_bot: boolean;
      equity: number;
      return_pct: number;
    }>(
      `SELECT lr.rank,
              lr.portfolio_id,
              CASE WHEN p.algo_id IS NOT NULL THEN a.name
                   ELSE u.display_name
              END AS display_name,
              (p.algo_id IS NOT NULL) AS is_bot,
              lr.equity,
              lr.return_pct
       FROM leaderboard_row lr
       JOIN portfolio  p ON p.id = lr.portfolio_id
       JOIN app_user   u ON u.id = p.user_id
       LEFT JOIN algo  a ON a.id = p.algo_id
       WHERE lr.taken_at = $1
       ${cursorFilter}
       ORDER BY lr.rank, lr.portfolio_id
       LIMIT $2`,
      params,
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const leaderboardRows: LeaderboardRowItem[] = pageRows.map((r) => ({
      rank: r.rank,
      portfolioId: r.portfolio_id,
      displayName: r.display_name,
      isBot: r.is_bot,
      equity: r.equity,
      returnPct: r.return_pct,
    }));

    const response: LeaderboardResponse = {
      takenAt,
      rows: leaderboardRows,
      nextCursor: hasMore
        ? encodeCursor({
            rank: pageRows[pageRows.length - 1]!.rank,
            portfolio_id: pageRows[pageRows.length - 1]!.portfolio_id,
          })
        : null,
    };

    // Warm cache for first page if this was a cache miss.
    if (!cursor && response.rows.length <= TOP_N) {
      await writeLeaderboardCache(redis, response);
    }

    return response;
  });
}
