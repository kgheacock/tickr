import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';
import { createInvite } from '../../fantasy/leagues.js';
import { sendFantasyError } from './_shared.js';

const inviteSchema = z.object({
  expiresInHours: z.number().int().optional(),
  maxUses: z.number().int().optional(),
});

export function registerInviteRoute(fastify: FastifyInstance): void {
  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/invites',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = inviteSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      try {
        const invite = await createInvite(
          req.params.id,
          parsed.data,
          req.userId!,
          pool,
        );
        return reply.code(201).send(invite);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
