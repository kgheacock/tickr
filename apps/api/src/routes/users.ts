/**
 * User lookup used by the admin create-league flow. When an admin seeds a new
 * league's roster, the manager picker checks each invitee email against the
 * registered user base so it can flag people who still need to sign in before
 * they can claim their team.
 *
 * Admin-gated: an open "does this email have an account" endpoint would be an
 * email-enumeration oracle, so it sits behind the same gate as league creation.
 * Matching is case-insensitive — app_user.email is captured verbatim from the
 * OAuth provider, so a case mismatch must not read as "no account".
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAdmin } from '../auth/middleware.js';

const querySchema = z.object({ email: z.string().min(1) });

export function registerUsersRoutes(fastify: FastifyInstance): void {
  fastify.get(
    '/users/exists',
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: 'email is required' },
        });
      }
      const { rows } = await pool.query(
        `SELECT 1 FROM app_user WHERE lower(email) = lower($1) LIMIT 1`,
        [parsed.data.email.trim()],
      );
      return reply.send({ exists: rows.length > 0 });
    },
  );
}
