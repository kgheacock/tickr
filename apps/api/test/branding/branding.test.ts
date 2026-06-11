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
  await client.query(`DELETE FROM symbol_branding`);
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

async function buildApp() {
  const app = Fastify({ logger: false });
  const { registerBrandingRoutes } =
    await import('../../src/routes/branding.js');
  await registerBrandingRoutes(app);
  await app.ready();
  return app;
}

async function seedSymbol(symbol: string): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
    [symbol],
  );
}

async function seedBranding(
  symbol: string,
  opts: {
    logo?: { bytes: Buffer; type: string };
    icon?: { bytes: Buffer; type: string };
  },
): Promise<void> {
  await client.query(
    `INSERT INTO symbol_branding
       (symbol, logo_bytes, logo_content_type, logo_fetched_at,
               icon_bytes, icon_content_type, icon_fetched_at)
     VALUES ($1, $2::bytea, $3::text,
                 CASE WHEN $2::bytea IS NULL THEN NULL ELSE now() END,
                 $4::bytea, $5::text,
                 CASE WHEN $4::bytea IS NULL THEN NULL ELSE now() END)`,
    [
      symbol,
      opts.logo?.bytes ?? null,
      opts.logo?.type ?? null,
      opts.icon?.bytes ?? null,
      opts.icon?.type ?? null,
    ],
  );
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('branding routes', () => {
  it('serves the logo without authentication (public asset)', async () => {
    await seedSymbol('AAPL');
    await seedBranding('AAPL', { logo: { bytes: SVG, type: 'image/svg+xml' } });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/logo',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/svg+xml');
      expect(res.headers['cache-control']).toContain('public');
      expect(res.headers['cache-control']).toContain('immutable');
      expect(res.headers['etag']).toBeTruthy();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain(
        "default-src 'none'",
      );
      expect(res.rawPayload.equals(SVG)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('serves the icon and honors the content-type independently of the logo', async () => {
    await seedSymbol('MSFT');
    await seedBranding('MSFT', {
      logo: { bytes: SVG, type: 'image/svg+xml' },
      icon: { bytes: PNG, type: 'image/png' },
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/MSFT/icon',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.rawPayload.equals(PNG)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('returns 304 on a matching If-None-Match', async () => {
    await seedSymbol('AAPL');
    await seedBranding('AAPL', { logo: { bytes: SVG, type: 'image/svg+xml' } });
    const app = await buildApp();
    try {
      const first = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/logo',
      });
      const etag = first.headers['etag'] as string;
      const second = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/logo',
        headers: { 'if-none-match': etag },
      });
      expect(second.statusCode).toBe(304);
      expect(second.rawPayload.length).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('404s for a symbol with no branding row', async () => {
    await seedSymbol('AAPL');
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/AAPL/logo',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('404s for a present-but-null image (icon stored, logo absent)', async () => {
    await seedSymbol('NVDA');
    await seedBranding('NVDA', { icon: { bytes: PNG, type: 'image/png' } });
    const app = await buildApp();
    try {
      const logo = await app.inject({
        method: 'GET',
        url: '/symbols/NVDA/logo',
      });
      expect(logo.statusCode).toBe(404);
      const icon = await app.inject({
        method: 'GET',
        url: '/symbols/NVDA/icon',
      });
      expect(icon.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('looks up the symbol case-insensitively', async () => {
    await seedSymbol('AAPL');
    await seedBranding('AAPL', { logo: { bytes: SVG, type: 'image/svg+xml' } });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/aapl/logo',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('resolves a dotted share-class symbol in the path (e.g. BRK.B)', async () => {
    // The universe now stores dotted symbols; the dot must survive Fastify route
    // matching for the one symbol-in-path endpoint.
    await seedSymbol('BRK.B');
    await seedBranding('BRK.B', {
      logo: { bytes: SVG, type: 'image/svg+xml' },
    });
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/symbols/BRK.B/logo',
      });
      expect(res.statusCode).toBe(200);
      expect(res.rawPayload.equals(SVG)).toBe(true);
    } finally {
      await app.close();
    }
  });
});
