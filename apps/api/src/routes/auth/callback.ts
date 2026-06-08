import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { getRedis } from '../../redis.js';
import { requireEnv } from '../../config.js';
import { verifyState } from '../../auth/hmac.js';
import { consumeOAuthAttempt, createSession } from '../../auth/session.js';
import { buildGoogleConfig, exchangeGoogleCode } from '../../auth/google.js';
import { exchangeGitHubCode } from '../../auth/github.js';
import {
  upsertUserAndIdentity,
  attachIdentity,
  ensurePortfolio,
} from '../../auth/upsert.js';

const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function callbackUri(baseUrl: string, provider: string): string {
  return `${baseUrl}/api/v1/auth/${provider}/callback`;
}

async function handleCallback(
  req: { url: string; cookies: Record<string, string | undefined> },
  reply: {
    code: (n: number) => { send: (v: unknown) => unknown };
    clearCookie: (name: string, opts: object) => unknown;
    setCookie: (name: string, val: string, opts: object) => unknown;
    redirect: (url: string) => unknown;
  },
  opts: {
    baseUrl: string;
    signingKey: string;
    isLink: boolean;
    provider: 'google' | 'github';
  },
): Promise<unknown> {
  const { baseUrl, signingKey, isLink, provider } = opts;
  const redis = getRedis();

  // Parse query params from req.url
  const reqUrl = new URL(req.url, baseUrl);
  const state = reqUrl.searchParams.get('state');
  const code = reqUrl.searchParams.get('code');

  if (!state || !code) {
    return reply.code(400).send({
      error: { code: 'VALIDATION', message: 'Missing state or code' },
    });
  }

  // Verify tickr_oauth_attempt cookie matches state
  const attemptCookie = req.cookies['tickr_oauth_attempt'];
  if (!attemptCookie || !verifyState(state, attemptCookie, signingKey)) {
    return reply.code(400).send({
      error: { code: 'VALIDATION', message: 'Invalid OAuth attempt' },
    });
  }
  reply.clearCookie('tickr_oauth_attempt', { path: '/' });

  // Consume OAuth attempt from Redis (single-use)
  const attempt = await consumeOAuthAttempt(redis, state);
  if (!attempt || attempt.provider !== provider) {
    return reply.code(400).send({
      error: {
        code: 'VALIDATION',
        message: 'Unknown or expired OAuth state',
      },
    });
  }

  // isLink is authoritative from the stored attempt, not the route
  const resolvedIsLink = isLink || !!attempt.linkUserId;
  const redirectUri = callbackUri(baseUrl, provider);

  // Exchange code for profile
  let profile: {
    sub: string;
    email: string | null;
    emailVerified: boolean;
    name: string | null;
  };
  if (provider === 'google') {
    const config = await buildGoogleConfig();
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = reqUrl.search;
    profile = await exchangeGoogleCode(
      config,
      callbackUrl,
      attempt.codeVerifier,
      state,
    );
  } else {
    profile = await exchangeGitHubCode(code, attempt.codeVerifier, redirectUri);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (resolvedIsLink && attempt.linkUserId) {
      await attachIdentity(client, {
        userId: attempt.linkUserId,
        provider,
        providerSubject: profile.sub,
        email: profile.email,
      });
      await client.query('COMMIT');

      const { token } = await createSession(redis, attempt.linkUserId);
      reply.setCookie('tickr_sid', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_COOKIE_MAX_AGE,
      });
      return reply.redirect(`${baseUrl}/portfolio`);
    }

    const { userId } = await upsertUserAndIdentity(client, {
      provider,
      providerSubject: profile.sub,
      email: profile.email,
      emailVerified: profile.emailVerified,
      displayName: profile.name,
    });

    await ensurePortfolio(client, userId);
    await client.query('COMMIT');

    const { token } = await createSession(redis, userId);
    reply.setCookie('tickr_sid', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE,
    });
    return reply.redirect(`${baseUrl}/portfolio`);
  } catch (err) {
    await client.query('ROLLBACK');
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'IDENTITY_CONFLICT') {
      return reply
        .code(409)
        .send({ error: { code: 'CONFLICT', message: e.message } });
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function registerCallbackRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const baseUrl = requireEnv('PUBLIC_BASE_URL');
  const signingKey = requireEnv('SESSION_SIGNING_KEY');

  fastify.get<{ Params: { provider: string } }>(
    '/auth/:provider/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { provider } = req.params;
      if (provider !== 'google' && provider !== 'github') {
        return reply
          .code(400)
          .send({ error: { code: 'VALIDATION', message: 'Unknown provider' } });
      }
      return handleCallback(req, reply, {
        baseUrl,
        signingKey,
        isLink: false,
        provider,
      });
    },
  );

  fastify.get<{ Params: { provider: string } }>(
    '/auth/link/:provider/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { provider } = req.params;
      if (provider !== 'google' && provider !== 'github') {
        return reply
          .code(400)
          .send({ error: { code: 'VALIDATION', message: 'Unknown provider' } });
      }
      return handleCallback(req, reply, {
        baseUrl,
        signingKey,
        isLink: true,
        provider,
      });
    },
  );
}
