import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';
import { getUserLeagues } from '../fantasy/leagues.js';

export async function registerMeRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/me', { preHandler: [requireAuth] }, async (req) => {
    const userId = req.userId!;

    const userRow = await pool.query<{
      id: string;
      display_name: string;
      email: string | null;
      role: string;
      created_at: Date;
    }>(
      `SELECT id, display_name, email, role, created_at FROM app_user WHERE id = $1`,
      [userId],
    );

    const identityRows = await pool.query<{
      provider: string;
      email_at_link: string | null;
    }>(`SELECT provider, email_at_link FROM identity WHERE user_id = $1`, [
      userId,
    ]);

    const user = userRow.rows[0]!;

    // `/me` is a core platform endpoint (login bootstrap), so it must not hard
    // depend on Fantasy Street being present. If the FS schema is absent —
    // rolled back independently, or not yet migrated — degrade to no leagues
    // rather than 500 the whole response. 42P01 = undefined_table; any other
    // error is a real fault and still propagates.
    let leagues: Awaited<ReturnType<typeof getUserLeagues>> = [];
    try {
      leagues = await getUserLeagues(userId, pool);
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') {
        req.log.warn(
          { err: String(err) },
          'fantasy tables unavailable — returning /me without leagues',
        );
      } else {
        throw err;
      }
    }

    return {
      user: {
        id: user.id,
        displayName: user.display_name,
        email: user.email,
        role: user.role,
        createdAt: user.created_at.toISOString(),
      },
      identities: identityRows.rows.map((r) => ({
        provider: r.provider,
        emailAtLink: r.email_at_link,
      })),
      csrfToken: req.session!.csrfToken,
      leagues,
    };
  });
}
