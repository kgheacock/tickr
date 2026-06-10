import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireAuth } from '../../auth/middleware.js';
import { getLeagueView } from '../../fantasy/leagues.js';
import { sendFantasyError } from './_shared.js';

export function registerViewLeagueRoute(fastify: FastifyInstance): void {
  fastify.get<{ Params: { id: string } }>(
    '/leagues/:id',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      try {
        return await getLeagueView(req.params.id, req.userId!, pool);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
