import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { getRedis } from '../../redis.js';
import { createSession } from '../../auth/session.js';
import { upsertUserAndIdentity } from '../../auth/upsert.js';

const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * DEV-ONLY auth bypass. Mints a REAL session for a synthetic local user so the
 * authed UI and the logout flow can be exercised without Google OAuth — making
 * client-side auth bugs reproducible end-to-end.
 *
 * An optional `{ email }` body impersonates that account instead: the verified
 * email merges onto the existing `app_user` with that address (or creates one if
 * none exists), so you can log in as a real local user — e.g. to view a league
 * they own. Omit it for the default synthetic `dev@local.tickr` user.
 *
 * The synthetic user is an admin by default (the historical behaviour). Pass
 * `{ admin: false }` to log in as a plain player instead — handy for exercising
 * the invite-only, non-admin onboarding view (e.g. the gated "Start a League"
 * CTA). The flag applies to the synthetic user only; when impersonating by
 * email you take on that real account's own role.
 *
 * This is a genuine backdoor: it grants a session to anyone who can POST here.
 * It is registered ONLY when TICKR_DEV_AUTH is enabled (see roles/api.ts, which
 * defaults closed), and scripts/deploy.sh refuses to deploy if TICKR_DEV_AUTH
 * is set in the production secrets file. Never enable it in production.
 */
export async function registerDevLoginRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post<{ Body?: { email?: unknown; admin?: unknown } }>(
    '/auth/dev-login',
    async (req, reply) => {
      const rawEmail = req.body?.email;
      const email =
        typeof rawEmail === 'string' && rawEmail.trim()
          ? rawEmail.trim().toLowerCase()
          : null;
      // Admin by default; only a literal `admin: false` opts down to player.
      const role = req.body?.admin === false ? 'player' : 'admin';

      const redis = getRedis();
      const client = await pool.connect();
      let userId: string;
      try {
        await client.query('BEGIN');
        // Stable provider_subject → idempotent: re-running reuses the same user.
        // When impersonating, a per-email subject lets the verified-email merge
        // in upsertUserAndIdentity bind the session to the existing account
        // without overwriting its profile (displayName left null).
        ({ userId } = await upsertUserAndIdentity(client, {
          provider: 'google',
          providerSubject: email ? `dev-login:${email}` : 'dev-login',
          email: email ?? 'dev@local.tickr',
          emailVerified: true,
          displayName: email ? null : 'Dev User',
          role,
        }));
        // upsert only writes role when it *creates* the user, but the synthetic
        // dev user usually already exists from a prior login — so set the role
        // explicitly to make the admin toggle take effect on re-runs. Scoped to
        // the synthetic user; impersonation leaves the real account's role be.
        if (!email) {
          await client.query(`UPDATE app_user SET role = $2 WHERE id = $1`, [
            userId,
            role,
          ]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const { token } = await createSession(redis, userId);
      reply.setCookie('tickr_sid', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_COOKIE_MAX_AGE,
      });
      return reply.code(204).send();
    },
  );
}
