import type { FastifyRequest, FastifyReply } from 'fastify';
import { getRedis } from '../redis.js';
import { pool } from '../db/pool.js';
import { getSession, touchSession } from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    sessionToken?: string;
    session?: import('./session.js').SessionRecord;
    userId?: string;
  }
}

export async function sessionMiddleware(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = req.cookies['tickr_sid'];
  if (!token) return;

  const redis = getRedis();
  const record = await getSession(redis, token);
  if (!record) {
    reply.clearCookie('tickr_sid', { path: '/' });
    return;
  }

  req.sessionToken = token;
  req.session = record;
  req.userId = record.userId;

  await touchSession(redis, token, record);
}

export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await sessionMiddleware(req, reply);
  if (!req.userId) {
    return reply.code(401).send({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  }
}

export async function requireCsrf(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = req.headers['x-csrf-token'];
  if (!token || token !== req.session?.csrfToken) {
    return reply.code(403).send({
      error: { code: 'FORBIDDEN', message: 'Invalid CSRF token' },
    });
  }
}

/** Require an authenticated caller with the `admin` role; else 401/403. */
export async function requireAdmin(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(req, reply);
  if (!req.userId) return; // requireAuth already sent 401

  const { rows } = await pool.query<{ role: string }>(
    `SELECT role FROM app_user WHERE id = $1`,
    [req.userId],
  );
  if (rows[0]?.role !== 'admin') {
    return reply
      .code(403)
      .send({ error: { code: 'FORBIDDEN', message: 'Admin access required' } });
  }
}
