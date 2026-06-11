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
import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();

  const connectionString = container.getConnectionUri();
  await runner({
    databaseUrl: connectionString,
    dir: migrationsDir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
  });

  client = new pg.Client({ connectionString });
  await client.connect();
  pool = new pg.Pool({ connectionString });
}, 120_000);

afterAll(async () => {
  await client?.end();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await client.query(`DELETE FROM symbol_metadata`);
  await client.query(`DELETE FROM universe_symbol`);
  vi.resetModules();
});

vi.mock('../../src/db/pool.js', async () => {
  const _pg = await import('pg');
  const proxy = new Proxy({} as _pg.Pool, {
    get(_t, prop: string | symbol) {
      const p: _pg.Pool = pool;
      const val = (p as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === 'function' ? val.bind(p) : val;
    },
  });
  return { pool: proxy };
});

// Stub the real auth (which needs Redis + a session) with a header gate: callers
// presenting x-test-auth are authenticated, everyone else gets the same 401 the
// real requireAuth sends. This isolates the route's own behavior from the
// session machinery, which has its own tests.
vi.mock('../../src/auth/middleware.js', () => ({
  requireAuth: async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers['x-test-auth'] === '1') {
      (req as { userId?: string }).userId = 'test-user';
      return;
    }
    return reply.code(401).send({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
    });
  },
}));

async function buildApp() {
  const app = Fastify({ logger: false });
  const { registerMetadataRoute } =
    await import('../../src/routes/metadata.js');
  await registerMetadataRoute(app);
  await app.ready();
  return app;
}

async function seedSymbol(symbol: string): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
    [symbol],
  );
}

async function seedMetadata(
  symbol: string,
  cols: Record<string, unknown>,
): Promise<void> {
  const keys = Object.keys(cols);
  const placeholders = keys.map((_, i) => `$${i + 2}`).join(', ');
  await client.query(
    `INSERT INTO symbol_metadata (symbol, massive_ticker, ${keys.join(', ')}, fetched_at)
     VALUES ($1, $1, ${placeholders}, now())`,
    [symbol, ...keys.map((k) => cols[k])],
  );
}

const AUTH = { 'x-test-auth': '1' };

describe('symbol metadata route', () => {
  it('returns the broken-out metadata fields for an authenticated caller', async () => {
    await seedSymbol('AAPL');
    await seedMetadata('AAPL', {
      name: 'Apple Inc.',
      primary_exchange: 'XNAS',
      type: 'CS',
      market_cap: '3000000000000',
      sic_code: '3571',
      sic_description: 'ELECTRONIC COMPUTERS',
      homepage_url: 'https://www.apple.com',
      list_date: '1980-12-12',
      total_employees: 161000,
      description: 'Maker of iPhones.',
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/metadata',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        symbol: 'AAPL',
        name: 'Apple Inc.',
        primaryExchange: 'XNAS',
        type: 'CS',
        marketCap: 3000000000000,
        sicCode: '3571',
        sicDescription: 'ELECTRONIC COMPUTERS',
        homepageUrl: 'https://www.apple.com',
        listDate: '1980-12-12',
        totalEmployees: 161000,
        description: 'Maker of iPhones.',
      });
      expect(typeof body.fetchedAt).toBe('string');
      // The full upstream payload and internal bookkeeping are not exposed.
      expect(body).not.toHaveProperty('raw');
      expect(body).not.toHaveProperty('updatedAt');
      expect(body).not.toHaveProperty('massiveTicker');
    } finally {
      await app.close();
    }
  });

  it('preserves nulls for absent fields', async () => {
    await seedSymbol('AAPL');
    await seedMetadata('AAPL', { name: 'Apple Inc.' });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/metadata',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.marketCap).toBeNull();
      expect(body.listDate).toBeNull();
      expect(body.totalEmployees).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('401s an unauthenticated caller', async () => {
    await seedSymbol('AAPL');
    await seedMetadata('AAPL', { name: 'Apple Inc.' });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/metadata',
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('404s a symbol with no metadata row', async () => {
    await seedSymbol('AAPL');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/metadata',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('resolves a dotted share-class symbol in the path (e.g. BRK.B)', async () => {
    // The universe stores dotted symbols; the dot must survive Fastify route
    // matching for this symbol-in-path endpoint, same as the branding routes.
    await seedSymbol('BRK.B');
    await seedMetadata('BRK.B', { name: 'Berkshire Hathaway Inc.' });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/BRK.B/metadata',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().symbol).toBe('BRK.B');
    } finally {
      await app.close();
    }
  });

  it('looks up the symbol case-insensitively', async () => {
    await seedSymbol('AAPL');
    await seedMetadata('AAPL', { name: 'Apple Inc.' });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/aapl/metadata',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().symbol).toBe('AAPL');
    } finally {
      await app.close();
    }
  });
});
