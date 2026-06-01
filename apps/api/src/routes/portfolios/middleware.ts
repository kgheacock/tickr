import type { FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';

export async function requirePortfolioAccess(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(req, reply);
  if (!req.userId) return;

  const { rows: portRows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM portfolio WHERE id = $1`,
    [req.params.id],
  );
  if (!portRows[0]) {
    return reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Portfolio not found' } });
  }
  if (portRows[0].user_id === req.userId) return;

  const { rows: userRows } = await pool.query<{ role: string }>(
    `SELECT role FROM app_user WHERE id = $1`,
    [req.userId],
  );
  if (userRows[0]?.role === 'admin') return;

  return reply
    .code(403)
    .send({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
}

export async function requirePortfolioWrite(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  await requirePortfolioAccess(req, reply);
  if (reply.sent) return;
  await requireCsrf(req, reply);
}
