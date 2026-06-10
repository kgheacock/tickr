import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';
import { createLeague } from '../../fantasy/leagues.js';
import { sendFantasyError } from './_shared.js';

const rosterConfigSchema = z.object({
  slots: z.array(z.string()),
  bench: z.number().int(),
});

const createSchema = z.object({
  name: z.string().min(1),
  size: z.number().int(),
  seasonLengthWeeks: z.number().int(),
  rosterConfig: rosterConfigSchema.optional(),
  joinPolicy: z.enum(['invite', 'open']),
});

export function registerCreateLeagueRoute(fastify: FastifyInstance): void {
  fastify.post(
    '/leagues',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      try {
        const view = await createLeague(parsed.data, req.userId!, pool);
        return reply.code(201).send(view);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
