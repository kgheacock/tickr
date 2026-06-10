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
import type { Redis } from 'ioredis';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;

// runMetadataRefresh only passes redis through to the (mocked) bucket and
// metrics — nothing here touches a real server, so a dummy stand-in is enough.
const redis = {} as unknown as Redis;

beforeAll(async () => {
  vi.stubEnv('ROLE', 'worker');
  vi.stubEnv('MASSIVE_API_KEY', 'test-key');

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
  vi.unstubAllEnvs();
  await client?.end();
  await pool?.end();
  await container?.stop();
});

beforeEach(async () => {
  await client.query(`DELETE FROM symbol_branding`);
  await client.query(`DELETE FROM symbol_metadata`);
  await client.query(`DELETE FROM universe_symbol`);
  vi.restoreAllMocks();
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

vi.mock('../../src/massive/bucket.js', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  BUCKET_KEY: 'massive:bucket',
}));

// No Redis in this test — make the fire-and-forget metric writes no-ops.
vi.mock('../../src/metrics/redis.js', () => ({
  recordMassiveCall: vi.fn().mockResolvedValue(undefined),
  recordMassive429: vi.fn().mockResolvedValue(undefined),
}));

const LOGO_URL = 'https://api.massive.com/v1/reference/branding/x/logo.svg';
const ICON_URL = 'https://api.massive.com/v1/reference/branding/x/icon.png';

function detailsResponse(
  ticker: string,
  opts: { branding?: boolean } = {},
): Response {
  const branding =
    opts.branding === false
      ? undefined
      : {
          logo_url: LOGO_URL,
          icon_url: ICON_URL,
        };
  return new Response(
    JSON.stringify({
      request_id: 'r',
      results: {
        ticker,
        name: `${ticker} Inc.`,
        primary_exchange: 'XNAS',
        type: 'CS',
        market_cap: 1234567890,
        sic_code: '3571',
        sic_description: 'ELECTRONIC COMPUTERS',
        homepage_url: 'https://example.com',
        list_date: '1990-01-02',
        total_employees: 1000,
        description: 'A company.',
        branding,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// Route the stubbed fetch by URL: reference details (JSON) vs image bytes.
function makeFetch(
  overrides: Record<string, () => Promise<Response>> = {},
): ReturnType<typeof vi.fn> {
  return vi.fn().mockImplementation((url: string) => {
    if (overrides[url]) return overrides[url]();
    if (url.includes('/v3/reference/tickers/')) {
      const ticker = url.split('/v3/reference/tickers/')[1]!.split('?')[0]!;
      return Promise.resolve(detailsResponse(ticker));
    }
    if (url === LOGO_URL) {
      return Promise.resolve(
        new Response(Buffer.from('<svg/>'), {
          status: 200,
          headers: { 'content-type': 'image/svg+xml' },
        }),
      );
    }
    if (url === ICON_URL) {
      return Promise.resolve(
        new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

async function seed(symbol: string): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
    [symbol],
  );
}

describe('refreshMetadata', () => {
  it('stores metadata and downloads logo + icon for a fresh symbol', async () => {
    await seed('AAPL');
    vi.stubGlobal('fetch', makeFetch());

    const { runMetadataRefresh } =
      await import('../../src/jobs/refresh-metadata.js');
    const result = await runMetadataRefresh(redis);

    expect(result).toMatchObject({
      total: 1,
      metadata: 1,
      logos: 1,
      icons: 1,
      failed: [],
    });

    const meta = await client.query(
      `SELECT name, primary_exchange, market_cap, sic_description, fetched_at
         FROM symbol_metadata WHERE symbol = 'AAPL'`,
    );
    expect(meta.rows[0]).toMatchObject({
      name: 'AAPL Inc.',
      primary_exchange: 'XNAS',
      sic_description: 'ELECTRONIC COMPUTERS',
    });
    expect(meta.rows[0]!.market_cap).toBe('1234567890');
    expect(meta.rows[0]!.fetched_at).toBeInstanceOf(Date);

    const brand = await client.query(
      `SELECT logo_content_type, icon_content_type, octet_length(logo_bytes) AS logo_len,
              octet_length(icon_bytes) AS icon_len, logo_fetched_at, icon_fetched_at
         FROM symbol_branding WHERE symbol = 'AAPL'`,
    );
    expect(brand.rows[0]).toMatchObject({
      logo_content_type: 'image/svg+xml',
      icon_content_type: 'image/png',
    });
    expect(brand.rows[0]!.logo_len).toBeGreaterThan(0);
    expect(brand.rows[0]!.icon_len).toBeGreaterThan(0);
    expect(brand.rows[0]!.logo_fetched_at).toBeInstanceOf(Date);
    expect(brand.rows[0]!.icon_fetched_at).toBeInstanceOf(Date);
  });

  it('normalizes dash share-class tickers to the dotted Massive form', async () => {
    await seed('BRK-B');
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { runMetadataRefresh } =
      await import('../../src/jobs/refresh-metadata.js');
    await runMetadataRefresh(redis);

    const calledUrls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calledUrls.some((u) => u.includes('/tickers/BRK.B'))).toBe(true);
    const meta = await client.query(
      `SELECT massive_ticker FROM symbol_metadata WHERE symbol = 'BRK-B'`,
    );
    expect(meta.rows[0]!.massive_ticker).toBe('BRK.B');
  });

  it('is idempotent: a second run within the TTL fetches nothing', async () => {
    await seed('MSFT');
    const fetchMock = makeFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { runMetadataRefresh } =
      await import('../../src/jobs/refresh-metadata.js');
    await runMetadataRefresh(redis);
    const firstCallCount = fetchMock.mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    const second = await runMetadataRefresh(redis);
    expect(second.total).toBe(0);
    // No further network calls — everything is fresh within the TTL.
    expect(fetchMock.mock.calls.length).toBe(firstCallCount);
  });

  it('partial failure: a failed icon keeps metadata + logo and re-arms next run', async () => {
    await seed('NVDA');
    let iconAttempts = 0;
    const flakyIcon = makeFetch({
      [ICON_URL]: () => {
        iconAttempts++;
        // Fail every attempt this run (client retries, then gives up).
        return Promise.resolve(new Response('boom', { status: 500 }));
      },
    });
    vi.stubGlobal('fetch', flakyIcon);

    const { runMetadataRefresh } =
      await import('../../src/jobs/refresh-metadata.js');
    const result = await runMetadataRefresh(redis);

    // The symbol is not a failure — metadata + logo succeeded; only the icon is
    // missing. icon download was attempted.
    expect(result).toMatchObject({
      metadata: 1,
      logos: 1,
      icons: 0,
      failed: [],
    });
    expect(iconAttempts).toBeGreaterThan(0);

    const brand = await client.query(
      `SELECT octet_length(logo_bytes) AS logo_len, icon_bytes, icon_fetched_at
         FROM symbol_branding WHERE symbol = 'NVDA'`,
    );
    expect(brand.rows[0]!.logo_len).toBeGreaterThan(0);
    expect(brand.rows[0]!.icon_bytes).toBeNull();
    expect(brand.rows[0]!.icon_fetched_at).toBeNull();

    // The metadata row exists and is fresh, but the missing icon must re-select
    // the symbol on the next run (proving partial failure re-arms).
    vi.stubGlobal('fetch', makeFetch());
    const second = await runMetadataRefresh(redis);
    expect(second.total).toBe(1);
    expect(second.icons).toBe(1);
  });

  it('a symbol with no branding stores metadata and reaches a quiet steady state', async () => {
    await seed('NOBRAND');
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/v3/reference/tickers/')) {
        return Promise.resolve(detailsResponse('NOBRAND', { branding: false }));
      }
      return Promise.resolve(new Response('nope', { status: 404 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { runMetadataRefresh } =
      await import('../../src/jobs/refresh-metadata.js');
    const result = await runMetadataRefresh(redis);
    expect(result).toMatchObject({
      metadata: 1,
      logos: 0,
      icons: 0,
      failed: [],
    });

    const meta = await client.query(
      `SELECT name FROM symbol_metadata WHERE symbol = 'NOBRAND'`,
    );
    expect(meta.rows[0]!.name).toBe('NOBRAND Inc.');

    // The absent logo/icon must be stamped "checked, none available" so the
    // symbol is NOT re-selected forever — the second run within the TTL is a
    // no-op (idempotency under missing branding).
    const brand = await client.query(
      `SELECT logo_bytes, logo_fetched_at, icon_bytes, icon_fetched_at
         FROM symbol_branding WHERE symbol = 'NOBRAND'`,
    );
    expect(brand.rows[0]!.logo_bytes).toBeNull();
    expect(brand.rows[0]!.icon_bytes).toBeNull();
    expect(brand.rows[0]!.logo_fetched_at).toBeInstanceOf(Date);
    expect(brand.rows[0]!.icon_fetched_at).toBeInstanceOf(Date);

    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await runMetadataRefresh(redis);
    expect(second.total).toBe(0);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
