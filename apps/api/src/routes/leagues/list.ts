import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireAuth } from '../../auth/middleware.js';
import { listLeagues } from '../../fantasy/leagues.js';

export function registerListLeaguesRoute(fastify: FastifyInstance): void {
  fastify.get<{
    Querystring: {
      mine?: string;
      open?: string;
      limit?: string;
      offset?: string;
    };
  }>('/leagues', { preHandler: [requireAuth] }, async (req) => {
    const { mine, open, limit, offset } = req.query;
    return listLeagues(
      {
        mine: mine === 'true',
        open: open === 'true',
        limit: limit !== undefined ? Number(limit) : undefined,
        offset: offset !== undefined ? Number(offset) : undefined,
      },
      req.userId!,
      pool,
    );
  });
}
