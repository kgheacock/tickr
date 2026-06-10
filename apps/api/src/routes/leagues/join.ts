import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';
import { joinLeague } from '../../fantasy/leagues.js';
import { sendFantasyError } from './_shared.js';

const joinSchema = z.object({
  token: z.string().optional(),
});

export function registerJoinLeagueRoute(fastify: FastifyInstance): void {
  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/join',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = joinSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      try {
        return await joinLeague(req.params.id, parsed.data, req.userId!, pool);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
