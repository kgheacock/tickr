import type { FastifyInstance } from 'fastify';
import { requirePortfolioAccess } from './middleware.js';
import { getPortfolioView } from './view-query.js';

export async function registerPortfolioViewRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{ Params: { id: string } }>(
    '/portfolios/:id',
    { preHandler: [requirePortfolioAccess] },
    async (req, reply) => {
      const view = await getPortfolioView(req.params.id);
      if (!view) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: 'Portfolio not found' },
        });
      }
      return view;
    },
  );
}
