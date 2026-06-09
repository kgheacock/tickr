import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { closePool } from '../../src/db/pool.js';
import { getRedis } from '../../src/redis.js';
import { createSession } from '../../src/auth/session.js';
import { appendRawLog, readRecentLogs } from '../../src/log/buffer.js';
import { rootLogger } from '../../src/log/logger.js';
import { registerAdminLogsRoutes } from '../../src/routes/admin/logs.js';

const SESSION_SIGNING_KEY = 'test-logs-signing-key-32bytes!!!';
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

interface LogEntry {
  id: string;
  level: string;
  time: number | null;
  msg: string;
  service?: string;
  extra: Record<string, unknown>;
}
interface LogsResponse {
  entries: LogEntry[];
  lastId: string | null;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_logs_test')
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
  await app.register(async (api) => registerAdminLogsRoutes(api), {
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

function logLine(level: string, msg: string, extra: object = {}): string {
  return JSON.stringify({
    level,
    time: Date.now(),
    msg,
    service: 'api',
    ...extra,
  });
}

describe('GET /admin/logs.json', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logs.json',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a player with 403', async () => {
    const token = await sessionFor(PLAYER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logs.json',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns recent entries oldest→newest for an admin', async () => {
    const redis = getRedis();
    await appendRawLog(redis, logLine('info', 'first'));
    await appendRawLog(redis, logLine('warn', 'second'));
    await appendRawLog(redis, logLine('error', 'third'));

    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logs.json',
      headers: { cookie: `tickr_sid=${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<LogsResponse>();
    expect(body.entries.map((e) => e.msg)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(body.entries[0]?.service).toBe('api');
    expect(body.lastId).toBe(body.entries[2]?.id);
  });

  it('filters to a minimum severity with ?level=', async () => {
    const redis = getRedis();
    await appendRawLog(redis, logLine('debug', 'noisy'));
    await appendRawLog(redis, logLine('info', 'normal'));
    await appendRawLog(redis, logLine('error', 'boom'));

    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logs.json?level=warn',
      headers: { cookie: `tickr_sid=${token}` },
    });

    const body = res.json<LogsResponse>();
    expect(body.entries.map((e) => e.msg)).toEqual(['boom']);
  });

  it('tails entries strictly after ?after=<id>', async () => {
    const redis = getRedis();
    await appendRawLog(redis, logLine('info', 'old'));

    const token = await sessionFor(ADMIN_ID);
    const first = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/logs.json',
        headers: { cookie: `tickr_sid=${token}` },
      })
    ).json<LogsResponse>();
    const cursor = first.lastId;
    expect(cursor).not.toBeNull();

    await appendRawLog(redis, logLine('info', 'new'));

    const tail = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/admin/logs.json?after=${cursor}`,
        headers: { cookie: `tickr_sid=${token}` },
      })
    ).json<LogsResponse>();

    expect(tail.entries.map((e) => e.msg)).toEqual(['new']);
  });

  it('passes a non-JSON line through as a raw message', async () => {
    await appendRawLog(getRedis(), 'not json at all');
    const token = await sessionFor(ADMIN_ID);
    const body = (
      await app.inject({
        method: 'GET',
        url: '/api/v1/admin/logs.json',
        headers: { cookie: `tickr_sid=${token}` },
      })
    ).json<LogsResponse>();
    expect(body.entries[0]?.msg).toBe('not json at all');
  });
});

/** Poll until at least one stored line matches `pred`, or time out. */
async function waitForLog(
  pred: (line: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { entries } = await readRecentLogs(getRedis(), 50);
    const hit = entries.find((e) => pred(e.line));
    if (hit) return hit.line;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('log line did not appear within timeout');
}

describe('pino → Redis fanout (write path)', () => {
  it('lands a logged line in the stream, parseable by the viewer', async () => {
    const marker = `fanout-${randomUUID()}`;
    rootLogger.info({ widget: 42 }, marker);

    const line = await waitForLog((l) => l.includes(marker));
    const parsed = JSON.parse(line);
    expect(parsed.msg).toBe(marker);
    expect(parsed.level).toBe('info');
    expect(parsed.service).toBe('api');
    expect(parsed.widget).toBe(42);
  });

  it('preserves redaction — secrets never reach the persisted stream', async () => {
    const marker = `redact-${randomUUID()}`;
    rootLogger.warn(
      { authorization: 'Bearer hunter2', cookie: 'sid=abc' },
      marker,
    );

    const line = await waitForLog((l) => l.includes(marker));
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('sid=abc');
    const parsed = JSON.parse(line);
    expect(parsed.authorization).toBe('[REDACTED]');
    expect(parsed.cookie).toBe('[REDACTED]');
  });
});

describe('GET /admin/logs', () => {
  it('serves the HTML viewer to an admin', async () => {
    const token = await sessionFor(ADMIN_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logs',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('tickr logs');
  });

  it('rejects a player with 403', async () => {
    const token = await sessionFor(PLAYER_ID);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/logs',
      headers: { cookie: `tickr_sid=${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
