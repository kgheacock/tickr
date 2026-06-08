import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { closePool } from '../../src/db/pool.js';
import { getRedis } from '../../src/redis.js';
import { registerStartRoutes } from '../../src/routes/auth/start.js';
import { registerCallbackRoutes } from '../../src/routes/auth/callback.js';
import { registerLogoutRoute } from '../../src/routes/auth/logout.js';
import { registerMeRoute } from '../../src/routes/me.js';

// Set env vars before any module that reads them lazily (pool, redis, routes)
const SESSION_SIGNING_KEY = 'test-flow-signing-key-32bytes!!';
process.env['SESSION_SIGNING_KEY'] = SESSION_SIGNING_KEY;
process.env['PUBLIC_BASE_URL'] = 'http://localhost:3000';
process.env['GITHUB_OAUTH_CLIENT_ID'] = 'gh-flow-test-client';
process.env['GITHUB_OAUTH_CLIENT_SECRET'] = 'gh-flow-test-secret';
process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'google-flow-test-client';
process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'google-flow-test-secret';
process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pgPool: pg.Pool;
let redis: Redis;

type FastifyApp = ReturnType<typeof Fastify>;
let app: FastifyApp;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_flow_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();

  const connectionString = container.getConnectionUri();

  // Reset the shared pool singleton so it picks up the new DATABASE_URL
  await closePool();
  process.env['DATABASE_URL'] = connectionString;

  await runner({
    databaseUrl: connectionString,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
  });

  pgPool = new pg.Pool({ connectionString });
  redis = new Redis(process.env['REDIS_URL']!);

  app = Fastify({ logger: false });
  await app.register(cookie, { secret: SESSION_SIGNING_KEY, parseOptions: {} });
  await app.register(
    async (api) => {
      await registerStartRoutes(api);
      await registerCallbackRoutes(api);
      await registerLogoutRoute(api);
      await registerMeRoute(api);
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await pgPool?.end();
  await closePool();
  try {
    await getRedis().quit();
  } catch {
    /* already disconnected */
  }
  await redis?.quit();
  await container?.stop();
});

beforeEach(async () => {
  await pgPool.query('DELETE FROM identity');
  await pgPool.query(
    "DELETE FROM app_user WHERE id != '00000000-0000-0000-0000-000000000001'",
  );
  await redis.flushdb();
});

/** Extract name=value pairs from one or more Set-Cookie header strings. */
function parseCookies(
  header: string | string[] | undefined,
): Record<string, string> {
  const headers = Array.isArray(header) ? header : [header ?? ''];
  const result: Record<string, string> = {};
  for (const h of headers) {
    const nameVal = h.split(';')[0] ?? '';
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx < 0) continue;
    const name = nameVal.slice(0, eqIdx).trim();
    const value = nameVal.slice(eqIdx + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

/** Join Set-Cookie values into a single string for use in assertions. */
function joinSetCookies(header: string | string[] | undefined): string {
  return Array.isArray(header) ? header.join(' ') : (header ?? '');
}

function mockGitHubFetch() {
  return vi.fn().mockImplementation((url: string) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: 'fake-gh-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 99_001,
            name: 'Flow Test User',
            login: 'flowtestuser',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    if (url === 'https://api.github.com/user/emails') {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { email: 'flowtest@example.com', primary: true, verified: true },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }
    throw new Error(`Unexpected fetch to: ${url}`);
  });
}

describe('GitHub sign-in → /me → logout flow', () => {
  it('completes the full flow and rejects subsequent /me after logout', async () => {
    // ── Step 1: start the OAuth flow ──────────────────────────────────────────
    const startRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/start',
    });

    expect(startRes.statusCode).toBe(302);

    const location = startRes.headers['location'] as string;
    expect(location).toContain('github.com/login/oauth/authorize');

    const locationUrl = new URL(location);
    const state = locationUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const startCookies = parseCookies(startRes.headers['set-cookie']);
    const attemptCookieValue = startCookies['tickr_oauth_attempt'];
    expect(attemptCookieValue).toBeTruthy();

    // Verify the attempt cookie carries the Secure attribute (gap fix)
    const startSetCookie = joinSetCookies(startRes.headers['set-cookie']);
    expect(startSetCookie).toContain('Secure');

    // ── Step 2: complete the callback with mocked GitHub API ──────────────────
    vi.stubGlobal('fetch', mockGitHubFetch());

    const callbackRes = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=testcode&state=${state!}`,
      headers: { cookie: `tickr_oauth_attempt=${attemptCookieValue}` },
    });

    vi.unstubAllGlobals();

    expect(callbackRes.statusCode).toBe(302);

    const callbackCookies = parseCookies(callbackRes.headers['set-cookie']);
    const sidToken = callbackCookies['tickr_sid'];
    expect(sidToken).toBeTruthy();

    const callbackSetCookie = joinSetCookies(callbackRes.headers['set-cookie']);
    expect(callbackSetCookie).toContain('HttpOnly');
    expect(callbackSetCookie).toContain('Secure');
    expect(callbackSetCookie).toContain('SameSite=Lax');

    // ── Step 3: GET /me ───────────────────────────────────────────────────────
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `tickr_sid=${sidToken!}` },
    });

    expect(meRes.statusCode).toBe(200);

    const me = meRes.json<{
      user: { email: string; displayName: string; role: string };
      identities: Array<{ provider: string }>;
      csrfToken: string;
    }>();

    expect(me.user.email).toBe('flowtest@example.com');
    expect(me.user.displayName).toBe('Flow Test User');
    expect(me.user.role).toBe('player');
    expect(me.csrfToken).toBeTruthy();
    expect(me.identities).toHaveLength(1);
    expect(me.identities[0]!.provider).toBe('github');

    const csrfToken = me.csrfToken;

    // ── Step 4: POST /auth/logout ─────────────────────────────────────────────
    const logoutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `tickr_sid=${sidToken!}`,
        'x-csrf-token': csrfToken,
      },
    });

    expect(logoutRes.statusCode).toBe(204);

    // ── Step 5: /me after logout → 401 ───────────────────────────────────────
    const meAfterRes = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `tickr_sid=${sidToken!}` },
    });

    expect(meAfterRes.statusCode).toBe(401);
  });

  it('account linking attaches a second identity and /me shows both', async () => {
    // ── Sign in via GitHub (reuse the same mock) ──────────────────────────────
    const startRes = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/github/start',
    });
    const state = new URL(
      startRes.headers['location'] as string,
    ).searchParams.get('state')!;
    const attemptCookieValue = parseCookies(startRes.headers['set-cookie'])[
      'tickr_oauth_attempt'
    ]!;

    vi.stubGlobal('fetch', mockGitHubFetch());
    const callbackRes = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/github/callback?code=testcode&state=${state}`,
      headers: { cookie: `tickr_oauth_attempt=${attemptCookieValue}` },
    });
    vi.unstubAllGlobals();

    const sidToken = parseCookies(callbackRes.headers['set-cookie'])[
      'tickr_sid'
    ]!;

    // GET /me to get the CSRF token and confirm initial state
    const meRes = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `tickr_sid=${sidToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const me = meRes.json<{
      identities: Array<{ provider: string }>;
      csrfToken: string;
    }>();
    expect(me.identities).toHaveLength(1);
    const csrfToken = me.csrfToken;

    // ── Start account-link flow for a second provider (GitHub again as a
    //   different subject to keep the test self-contained) ────────────────────
    //   We re-use a second GitHub mock that returns a different user id so it
    //   won't conflict with the first identity. To exercise the *link* path we
    //   call POST /auth/link/github/start then the link callback.

    const linkStartRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/link/github/start',
      headers: {
        cookie: `tickr_sid=${sidToken}`,
        'x-csrf-token': csrfToken,
      },
    });

    expect(linkStartRes.statusCode).toBe(302);
    const linkState = new URL(
      linkStartRes.headers['location'] as string,
    ).searchParams.get('state')!;
    const linkAttemptCookie = parseCookies(linkStartRes.headers['set-cookie'])[
      'tickr_oauth_attempt'
    ]!;

    // Mock GitHub returning a different user (id 99_002 vs 99_001 above)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url === 'https://github.com/login/oauth/access_token') {
          return Promise.resolve(
            new Response(JSON.stringify({ access_token: 'fake-gh-token-2' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        if (url === 'https://api.github.com/user') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: 99_002,
                name: 'Alt Account',
                login: 'altaccount',
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
          );
        }
        if (url === 'https://api.github.com/user/emails') {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                { email: 'alt@example.com', primary: true, verified: true },
              ]),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
          );
        }
        throw new Error(`Unexpected fetch: ${url}`);
      }),
    );

    const linkCallbackRes = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/link/github/callback?code=testcode2&state=${linkState}`,
      headers: { cookie: `tickr_oauth_attempt=${linkAttemptCookie}` },
    });

    vi.unstubAllGlobals();

    expect(linkCallbackRes.statusCode).toBe(302);

    // The link callback issues a new session token
    const newSidToken =
      parseCookies(linkCallbackRes.headers['set-cookie'])['tickr_sid'] ??
      sidToken;

    // /me should now show both identities on the same user
    const meAfterLinkRes = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `tickr_sid=${newSidToken}` },
    });

    expect(meAfterLinkRes.statusCode).toBe(200);
    const meAfterLink = meAfterLinkRes.json<{
      identities: Array<{ provider: string }>;
    }>();
    expect(meAfterLink.identities).toHaveLength(2);
  });
});
