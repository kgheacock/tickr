import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';
import { updateLeague } from '../../fantasy/leagues.js';
import { sendFantasyError } from './_shared.js';

const rosterConfigSchema = z.object({
  slots: z.array(z.string()),
  bench: z.number().int(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  size: z.number().int().optional(),
  seasonLengthWeeks: z.number().int().optional(),
  rosterConfig: rosterConfigSchema.optional(),
  joinPolicy: z.enum(['invite', 'open']).optional(),
});

export function registerSettingsRoute(fastify: FastifyInstance): void {
  fastify.patch<{ Params: { id: string } }>(
    '/leagues/:id',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      try {
        return await updateLeague(
          req.params.id,
          parsed.data,
          req.userId!,
          pool,
        );
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
