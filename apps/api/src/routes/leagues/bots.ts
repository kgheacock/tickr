/**
 * Fantasy Street item 10 — auto-manager (bot) routes, mounted under /api/v1.
 *   POST   /leagues/:id/bots          add N auto-managers (commissioner, forming)
 *   DELETE /leagues/:id/bots/:userId  remove one auto-manager before the draft
 *
 * Thin glue over the domain in fantasy/bots.ts; the commissioner/forming checks
 * live there so they're exercised without Redis. State-changing commissioner
 * actions, so they carry requireCsrf like invites/create/join.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';
import { addBots, removeBot } from '../../fantasy/bots.js';
import { sendFantasyError } from './_shared.js';

const addBotsSchema = z.object({
  count: z.number().int(),
});

export function registerBotRoutes(fastify: FastifyInstance): void {
  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/bots',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = addBotsSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      try {
        const view = await addBots(
          pool,
          req.params.id,
          parsed.data.count,
          req.userId!,
        );
        return reply.code(201).send(view);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/leagues/:id/bots/:userId',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      try {
        const view = await removeBot(
          pool,
          req.params.id,
          req.params.userId,
          req.userId!,
        );
        return view;
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
