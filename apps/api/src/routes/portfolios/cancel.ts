import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requirePortfolioWrite } from './middleware.js';

export async function registerCancelRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Params: { id: string; orderId: string } }>(
    '/portfolios/:id/orders/:orderId/cancel',
    { preHandler: [requirePortfolioWrite] },
    async (req, reply) => {
      const { id: portfolioId, orderId } = req.params;

      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM trade_order WHERE id = $1 AND portfolio_id = $2`,
        [orderId, portfolioId],
      );

      if (!rows[0]) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
      }

      // v1: all orders fill immediately — there are no resting orders to cancel.
      return reply.code(409).send({
        error: {
          code: 'ORDER_ALREADY_FILLED',
          message: 'Order has already been filled and cannot be cancelled',
        },
      });
    },
  );
}
