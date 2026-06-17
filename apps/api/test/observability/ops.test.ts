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
import { recordJobResult, JOB_DEFS } from '../../src/jobs/status.js';
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
    // Seed one job's status so we can assert it survives the HTTP route (Fastify
    // would strip response fields not in a response schema — /admin/ops has none).
    await recordJobResult(getRedis(), 'classifier', {
      ok: true,
      durationMs: 321,
    });
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
    // jobs[] is the data source for the /admin/jobs viewer: one entry per
    // registered job, with the seeded outcome flowing through.
    expect(body.jobs).toHaveLength(JOB_DEFS.length);
    const classifier = body.jobs.find((j) => j.name === 'classifier');
    expect(classifier?.lastOutcome).toBe('ok');
    expect(classifier?.lastDurationMs).toBe(321);
  });

  describe('worstLag', () => {
    // The lateral query reads from price_bar; seed a controlled corpus and read
    // it back. Each case resets both tables so the worst-lag pick is unambiguous.
    async function reset(): Promise<void> {
      await pgPool.query('DELETE FROM price_bar');
      await pgPool.query('DELETE FROM universe_symbol');
    }

    async function addSymbol(
      symbol: string,
      opts: {
        backfilled?: boolean;
        removedAt?: string | null;
        dataStatus?: string | null;
        latestBar?: string | null;
      } = {},
    ): Promise<void> {
      await pgPool.query(
        `INSERT INTO universe_symbol (symbol, backfilled, removed_at, data_status)
         VALUES ($1, $2, $3, $4)`,
        [
          symbol,
          opts.backfilled ?? true,
          opts.removedAt ?? null,
          opts.dataStatus ?? null,
        ],
      );
      if (opts.latestBar) {
        await pgPool.query(
          `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
           VALUES ($1, $2, 100, 100, 100, 100, 1)`,
          [symbol, opts.latestBar],
        );
      }
    }

    async function fetchOps(): Promise<OpsResponse> {
      const token = await sessionFor(ADMIN_ID);
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/admin/ops',
        headers: { cookie: `tickr_sid=${token}` },
      });
      expect(res.statusCode).toBe(200);
      return res.json<OpsResponse>();
    }

    afterAll(reset);

    it('is null when no playable symbol has any bars', async () => {
      await reset();
      await addSymbol('AAA', { latestBar: null });
      const body = await fetchOps();
      expect(body.worstLag).toBeNull();
    });

    it('picks the playable symbol whose latest bar is oldest', async () => {
      await reset();
      // FRESH printed seconds ago; STALE last printed 30d ago → STALE wins.
      const now = Date.now();
      await addSymbol('FRESH', {
        latestBar: new Date(now - 60_000).toISOString(),
      });
      // 30 days back so lagSec stays clearly large no matter when CI runs: the
      // reference is min(now, last close) and the longest closure run is ~5 days,
      // so `30d − delta` is always well over 2d (a 3d bar would clamp toward 0
      // over a holiday weekend).
      const staleTs = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
      await addSymbol('STALE', { latestBar: staleTs });

      const body = await fetchOps();
      expect(body.worstLag).not.toBeNull();
      expect(body.worstLag?.symbol).toBe('STALE');
      expect(body.worstLag?.latestBarAt).toBe(new Date(staleTs).toISOString());
      expect(body.worstLag?.lagSec).toBeGreaterThan(2 * 24 * 60 * 60);
    });

    it('ignores removed / incomplete / not-yet-backfilled symbols', async () => {
      await reset();
      const ancient = new Date('2000-01-03T21:00:00Z').toISOString();
      // All excluded by the playable predicate despite very old bars.
      await addSymbol('REMOVED', {
        removedAt: new Date().toISOString(),
        latestBar: ancient,
      });
      await addSymbol('INCOMPLETE', {
        dataStatus: 'incomplete',
        latestBar: ancient,
      });
      await addSymbol('PENDING', { backfilled: false, latestBar: ancient });
      // The only playable symbol — fresh — so it is the worst (and only) lag.
      const recent = new Date(Date.now() - 60_000).toISOString();
      await addSymbol('PLAYABLE', { latestBar: recent });

      const body = await fetchOps();
      expect(body.worstLag?.symbol).toBe('PLAYABLE');
    });
  });
});
