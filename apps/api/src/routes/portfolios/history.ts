import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requirePortfolioAccess } from './middleware.js';
import type { HistoryPage, ValuationSnapshot } from '@tickr/shared-types';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

export async function registerPortfolioHistoryRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string; cursor?: string };
  }>(
    '/portfolios/:id/history',
    { preHandler: [requirePortfolioAccess] },
    async (req, reply) => {
      const portfolioId = req.params.id;
      const limit = Math.min(
        Math.max(
          1,
          parseInt(req.query.limit ?? String(DEFAULT_LIMIT), 10) ||
            DEFAULT_LIMIT,
        ),
        MAX_LIMIT,
      );
      const cursor = req.query.cursor;

      const params: unknown[] = [portfolioId, limit + 1];
      let cursorFilter = '';
      if (cursor) {
        const takenAtCursor = Buffer.from(cursor, 'base64url').toString();
        cursorFilter = `AND vs.taken_at < $3`;
        params.push(takenAtCursor);
      }

      const { rows } = await pool.query<{
        id: string;
        portfolio_id: string;
        taken_at: Date;
        cash: number;
        positions_value: number;
        equity: number;
      }>(
        `SELECT id, portfolio_id, taken_at, cash, positions_value, equity
         FROM valuation_snapshot vs
         WHERE vs.portfolio_id = $1
         ${cursorFilter}
         ORDER BY vs.taken_at DESC
         LIMIT $2`,
        params,
      );

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;

      const items: ValuationSnapshot[] = pageRows.map((r) => ({
        id: r.id,
        portfolioId: r.portfolio_id,
        takenAt: r.taken_at.toISOString(),
        cash: r.cash,
        positionsValue: r.positions_value,
        equity: r.equity,
      }));

      const response: HistoryPage = {
        items,
        nextCursor: hasMore
          ? Buffer.from(
              pageRows[pageRows.length - 1]!.taken_at.toISOString(),
            ).toString('base64url')
          : null,
      };

      return reply.send(response);
    },
  );
}
