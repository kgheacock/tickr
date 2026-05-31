import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { ensurePortfolio } from '../auth/upsert.js';
import { requireAuth } from '../auth/middleware.js';

export async function registerMeRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/me', { preHandler: [requireAuth] }, async (req, _reply) => {
    const userId = req.userId!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const portfolioId = await ensurePortfolio(client, userId);

      const userRow = await client.query<{
        id: string;
        display_name: string;
        email: string | null;
        role: string;
        created_at: string;
      }>(
        `SELECT id, display_name, email, role, created_at FROM app_user WHERE id = $1`,
        [userId],
      );

      const identityRows = await client.query<{
        provider: string;
        email_at_link: string | null;
      }>(`SELECT provider, email_at_link FROM identity WHERE user_id = $1`, [
        userId,
      ]);

      await client.query('COMMIT');

      const user = userRow.rows[0]!;
      return {
        user: {
          id: user.id,
          displayName: user.display_name,
          email: user.email,
          role: user.role,
          createdAt: user.created_at,
        },
        identities: identityRows.rows.map((r) => ({
          provider: r.provider,
          emailAtLink: r.email_at_link,
        })),
        portfolioId,
        csrfToken: req.session!.csrfToken,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });
}
