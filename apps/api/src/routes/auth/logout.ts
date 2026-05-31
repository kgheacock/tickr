import type { FastifyInstance } from 'fastify';
import { getRedis } from '../../redis.js';
import { deleteSession } from '../../auth/session.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';

export async function registerLogoutRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    '/auth/logout',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      if (req.sessionToken) {
        await deleteSession(getRedis(), req.sessionToken);
      }
      return reply.clearCookie('tickr_sid', { path: '/' }).code(204).send();
    },
  );
}
