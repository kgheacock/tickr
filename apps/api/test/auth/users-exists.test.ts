import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { UserExistsResponse } from '@tickr/shared-types';
import { closePool } from '../../src/db/pool.js';
import { getRedis } from '../../src/redis.js';
import { createSession } from '../../src/auth/session.js';
import { registerUsersRoutes } from '../../src/routes/users.js';
import { registerCreateLeagueRoute } from '../../src/routes/leagues/create.js';
import { registerAdminToolRoutes } from '../../src/routes/leagues/admin.js';
import { registerDevLoginRoute } from '../../src/routes/auth/dev-login.js';
import { createLeague } from '../../src/fantasy/leagues.js';

const SESSION_SIGNING_KEY = 'test-users-signing-key-32bytes!!!';
process.env['SESSION_SIGNING_KEY'] = SESSION_SIGNING_KEY;
process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pgPool: pg.Pool;
type FastifyApp = ReturnType<typeof Fastify>;
let app: FastifyApp;

const ADMIN_ID = randomUUID();
const PLAYER_ID = randomUUID();

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_users_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();

  const connectionString = container.getConnectionUri();
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
  await pgPool.query(
    `INSERT INTO app_user (id, display_name, email, role)
     VALUES ($1,'Admin','Admin@Tickr.com','admin'),($2,'Player','p@x.com','player')`,
    [ADMIN_ID, PLAYER_ID],
  );

  app = Fastify({ logger: false });
  await app.register(cookie, { secret: SESSION_SIGNING_KEY, parseOptions: {} });
  await app.register(
    async (api) => {
      registerUsersRoutes(api);
      registerCreateLeagueRoute(api);
      registerAdminToolRoutes(api);
      await registerDevLoginRoute(api);
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
  await container?.stop();
});

async function sessionFor(userId: string): Promise<string> {
  const { token } = await createSession(getRedis(), userId);
  return token;
}

// State-changing routes also enforce CSRF, so these tests need the session's
// matching token in the x-csrf-token header.
async function sessionWithCsrf(
  userId: string,
): Promise<{ token: string; csrf: string }> {
  const { token, record } = await createSession(getRedis(), userId);
  return { token, csrf: record.csrfToken };
}

describe('GET /users/exists', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/exists?email=a@x.com',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-admin caller with 403 (no enumeration oracle)', async () => {
    const token = await sessionFor(PLAYER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/exists?email=a@x.com',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reports a registered email as existing for an admin', async () => {
    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/exists?email=p@x.com',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserExistsResponse>().exists).toBe(true);
  });

  it('matches case-insensitively (OAuth-captured casing must not read as missing)', async () => {
    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/exists?email=admin@tickr.com',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserExistsResponse>().exists).toBe(true);
  });

  it('reports an unknown email as missing', async () => {
    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/exists?email=nobody@nowhere.com',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserExistsResponse>().exists).toBe(false);
  });

  it('rejects a missing email param with 422', async () => {
    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/exists',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(422);
  });
});

// tickr is invite-only: leagues are minted by admins. The headline guard is the
// requireAdmin preHandler, which short-circuits before any createLeague machinery
// — so the 401/403 cases are as cheap as the lookup ones above. The 201 happy
// path (DB + draft) is covered by the createLeague domain tests.
describe('POST /leagues (admin-only)', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/leagues' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-admin caller with 403', async () => {
    const token = await sessionFor(PLAYER_ID);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/leagues',
      headers: { cookie: `tickr_sid=${token}` },
      payload: {
        name: 'Bear Market Bulls',
        seasonLengthWeeks: 14,
        joinPolicy: 'invite',
        members: [{ isBot: true }, { isBot: true }, { isBot: true }],
      },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /leagues/:id (admin-only)', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/leagues/${randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a non-admin caller with 403', async () => {
    const token = await sessionFor(PLAYER_ID);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/leagues/${randomUUID()}`,
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 404 for an unknown league id', async () => {
    const { token, csrf } = await sessionWithCsrf(ADMIN_ID);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/leagues/${randomUUID()}`,
      headers: { cookie: `tickr_sid=${token}`, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a populated league and cascades its child rows', async () => {
    // Seed a league with a real commissioner member, an email invite, and bots
    // — child rows across several fs_* tables — to prove the FK cascade for real
    // rather than trusting the migrations' ON DELETE clauses by inspection.
    const view = await createLeague(
      {
        name: 'Doomed League',
        seasonLengthWeeks: 14,
        joinPolicy: 'invite',
        members: [
          { isBot: false, email: 'invitee@example.com' },
          { isBot: true },
          { isBot: true },
        ],
      },
      ADMIN_ID,
      pgPool,
    );

    // Sanity-check the seed populated the child tables we expect to cascade.
    const before = await Promise.all([
      pgPool.query(`SELECT 1 FROM fs_league_member WHERE league_id = $1`, [
        view.id,
      ]),
      pgPool.query(`SELECT 1 FROM fs_invite WHERE league_id = $1`, [view.id]),
      pgPool.query(`SELECT 1 FROM fs_bot_member WHERE league_id = $1`, [
        view.id,
      ]),
    ]);
    expect(before.every((r) => r.rowCount && r.rowCount > 0)).toBe(true);

    const { token, csrf } = await sessionWithCsrf(ADMIN_ID);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/leagues/${view.id}`,
      headers: { cookie: `tickr_sid=${token}`, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(204);

    // The league and every dependent row are gone.
    const after = await Promise.all([
      pgPool.query(`SELECT 1 FROM fs_league WHERE id = $1`, [view.id]),
      pgPool.query(`SELECT 1 FROM fs_league_member WHERE league_id = $1`, [
        view.id,
      ]),
      pgPool.query(`SELECT 1 FROM fs_invite WHERE league_id = $1`, [view.id]),
      pgPool.query(`SELECT 1 FROM fs_bot_member WHERE league_id = $1`, [
        view.id,
      ]),
    ]);
    expect(after.every((r) => r.rowCount === 0)).toBe(true);
  });
});

// The synthetic dev user persists across logins, so the admin toggle must be
// applied explicitly (not just on first create) to flip an existing user.
describe('POST /auth/dev-login (admin toggle)', () => {
  async function roleOfDevUser(): Promise<string | undefined> {
    const { rows } = await pgPool.query<{ role: string }>(
      `SELECT role FROM app_user WHERE email = 'dev@local.tickr'`,
    );
    return rows[0]?.role;
  }

  it('defaults the synthetic user to admin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
    });
    expect(res.statusCode).toBe(204);
    expect(await roleOfDevUser()).toBe('admin');
  });

  it('demotes to player with { admin: false }, then back with { admin: true }', async () => {
    // Re-run on the already-admin user from the previous case: the toggle must
    // flip the existing row, not silently keep admin.
    const down = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { admin: false },
    });
    expect(down.statusCode).toBe(204);
    expect(await roleOfDevUser()).toBe('player');

    const up = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { admin: true },
    });
    expect(up.statusCode).toBe(204);
    expect(await roleOfDevUser()).toBe('admin');
  });
});
