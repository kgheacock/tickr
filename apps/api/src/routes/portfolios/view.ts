import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requirePortfolioAccess } from './middleware.js';

export async function registerPortfolioViewRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    '/portfolios/:id',
    { preHandler: [requirePortfolioAccess] },
    async (req, reply) => {
      const portfolioId = req.params.id;

      const { rows: portRows } = await pool.query<{
        id: string;
        user_id: string;
        algo_id: string | null;
        cash: number;
        joined_at: Date;
      }>(
        `SELECT id, user_id, algo_id, cash, joined_at FROM portfolio WHERE id = $1`,
        [portfolioId],
      );
      if (!portRows[0]) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Portfolio not found' },
        });
      }
      const port = portRows[0];

      const { rows: posRows } = await pool.query<{
        symbol: string;
        quantity: string;
        avg_cost: number;
        last_price: number | null;
      }>(
        `SELECT
           pos.symbol,
           pos.quantity::text,
           pos.avg_cost,
           pb.close AS last_price
         FROM position pos
         LEFT JOIN LATERAL (
           SELECT close
           FROM price_bar
           WHERE symbol = pos.symbol
           ORDER BY ts DESC
           LIMIT 1
         ) pb ON true
         WHERE pos.portfolio_id = $1`,
        [portfolioId],
      );

      const { rows: snapRows } = await pool.query<{ taken_at: Date }>(
        `SELECT taken_at FROM valuation_snapshot
         WHERE portfolio_id = $1
         ORDER BY taken_at DESC
         LIMIT 1`,
        [portfolioId],
      );

      let equity: number | null = port.cash;
      const positions = posRows.map((pos) => {
        const qty = parseFloat(pos.quantity);
        const marketValue =
          pos.last_price !== null ? Math.round(qty * pos.last_price) : null;
        if (marketValue === null) equity = null;
        else if (equity !== null) equity += marketValue;
        return {
          symbol: pos.symbol,
          quantity: qty,
          avgCost: pos.avg_cost,
          lastPrice: pos.last_price,
          marketValue,
        };
      });

      return {
        portfolio: {
          id: port.id,
          userId: port.user_id,
          algoId: port.algo_id,
          cash: port.cash,
          joinedAt: port.joined_at.toISOString(),
        },
        positions,
        equity,
        buyingPower: port.cash,
        lastSnapshotAt: snapRows[0]?.taken_at.toISOString() ?? null,
      };
    },
  );
}
