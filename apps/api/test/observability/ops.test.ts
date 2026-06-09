import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { OpsResponse } from '@tickr/shared-types';
import { closePool } from '../../src/db/pool.js';
import { getRedis } from '../../src/redis.js';
import { createSession } from '../../src/auth/session.js';
import { recordEodRun } from '../../src/metrics/redis.js';
import { registerAdminOpsRoute } from '../../src/routes/admin/ops.js';

const SESSION_SIGNING_KEY = 'test-ops-signing-key-32bytes!!!!';
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
    .withDatabase('tickr_ops_test')
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
    `INSERT INTO app_user (id, display_name, email, role) VALUES ($1,'Admin','a@x.com','admin'),($2,'Player','p@x.com','player')`,
    [ADMIN_ID, PLAYER_ID],
  );

  app = Fastify({ logger: false });
  await app.register(cookie, { secret: SESSION_SIGNING_KEY, parseOptions: {} });
  await app.register(async (api) => registerAdminOpsRoute(api), {
    prefix: '/api/v1',
  });
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

beforeEach(async () => {
  await getRedis().flushdb();
});

async function sessionFor(userId: string): Promise<string> {
  const { token } = await createSession(getRedis(), userId);
  return token;
}

describe('GET /admin/ops', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/ops' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a player with 403', async () => {
    const token = await sessionFor(PLAYER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/ops',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns the OpsResponse shape for an admin', async () => {
    await recordEodRun(getRedis(), 1234, 42);
    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/ops',
      headers: { cookie: `tickr_sid=${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<OpsResponse>();
    expect(body.lastEodUpdateAt).not.toBeNull();
    expect(typeof body.eodUpdateLagSec).toBe('number');
    expect(body.marketData429sLast24h).toEqual({ massive: 0 });
    expect(body.jobQueueDepth).toBe(0);
    expect(body.backfillRemaining).toBe(0);
  });
});
