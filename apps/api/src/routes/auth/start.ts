import type { FastifyInstance } from 'fastify';
import { getRedis } from '../../redis.js';
import { requireEnv } from '../../config.js';
import { signState } from '../../auth/hmac.js';
import { storeOAuthAttempt } from '../../auth/session.js';
import { buildGoogleConfig, buildGoogleStartUrl } from '../../auth/google.js';
import {
  buildGitHubStartUrl,
  randomPKCECodeVerifier,
  randomState,
} from '../../auth/github.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';

const OAUTH_COOKIE_TTL_SEC = 10 * 60;

function callbackUri(baseUrl: string, provider: string): string {
  return `${baseUrl}/api/v1/auth/${provider}/callback`;
}

async function buildAuthorizeUrl(
  provider: 'google' | 'github',
  redirectUri: string,
): Promise<{ authorizeUrl: string; state: string; codeVerifier: string }> {
  if (provider === 'google') {
    const config = await buildGoogleConfig();
    const { url, state, codeVerifier } = await buildGoogleStartUrl(
      config,
      redirectUri,
    );
    return { authorizeUrl: url.toString(), state, codeVerifier };
  }
  const state = randomState();
  const codeVerifier = randomPKCECodeVerifier();
  const url = await buildGitHubStartUrl(redirectUri, state, codeVerifier);
  return { authorizeUrl: url.toString(), state, codeVerifier };
}

export async function registerStartRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  const baseUrl = requireEnv('PUBLIC_BASE_URL');
  const signingKey = requireEnv('SESSION_SIGNING_KEY');
  const redis = getRedis();

  fastify.get<{ Params: { provider: string } }>(
    '/auth/:provider/start',
    async (req, reply) => {
      const { provider } = req.params;
      if (provider !== 'google' && provider !== 'github') {
        return reply
          .code(400)
          .send({ error: { code: 'VALIDATION', message: 'Unknown provider' } });
      }

      const { authorizeUrl, state, codeVerifier } = await buildAuthorizeUrl(
        provider,
        callbackUri(baseUrl, provider),
      );

      await storeOAuthAttempt(redis, state, { codeVerifier, provider });

      void reply
        .setCookie('tickr_oauth_attempt', signState(state, signingKey), {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/',
          maxAge: OAUTH_COOKIE_TTL_SEC,
        })
        .redirect(authorizeUrl);
    },
  );

  fastify.post<{ Params: { provider: string } }>(
    '/auth/link/:provider/start',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const { provider } = req.params;
      if (provider !== 'google' && provider !== 'github') {
        return reply
          .code(400)
          .send({ error: { code: 'VALIDATION', message: 'Unknown provider' } });
      }

      const { authorizeUrl, state, codeVerifier } = await buildAuthorizeUrl(
        provider,
        callbackUri(baseUrl, provider),
      );

      await storeOAuthAttempt(redis, state, {
        codeVerifier,
        provider,
        linkUserId: req.userId!,
      });

      reply.setCookie('tickr_oauth_attempt', signState(state, signingKey), {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: OAUTH_COOKIE_TTL_SEC,
      });
      return { url: authorizeUrl };
    },
  );
}
