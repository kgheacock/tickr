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
  // etf cascades to etf_weight; must come before universe_symbol to avoid FK
  // violation on etf_weight.symbol → universe_symbol.symbol.
  await client.query(`DELETE FROM etf`);
  await client.query(`DELETE FROM price_bar`);
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

async function seedSymbol(symbol: string, backfilled = true): Promise<void> {
  await client.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [symbol, backfilled],
  );
}

async function seedBar(
  symbol: string,
  ts: string,
  close: number,
): Promise<void> {
  await client.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close) VALUES ($1, $2, $3, $3, $3, $3)`,
    [symbol, ts, close],
  );
}

async function insertEtf(opts: {
  key: string;
  name: string;
  baseDate: string;
  baseValue?: number;
  weights: Record<string, number>;
}): Promise<string> {
  const baseValue = opts.baseValue ?? 10000;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO etf (key, name, base_value, base_date) VALUES ($1, $2, $3, $4) RETURNING id`,
    [opts.key, opts.name, baseValue, opts.baseDate],
  );
  const etfId = rows[0]!.id;
  for (const [sym, w] of Object.entries(opts.weights)) {
    await client.query(
      `INSERT INTO etf_weight (etf_id, symbol, weight) VALUES ($1, $2, $3)`,
      [etfId, sym, w],
    );
  }
  return etfId;
}

// ---------------------------------------------------------------------------
// etfSeries unit tests
// ---------------------------------------------------------------------------

describe('etfSeries', () => {
  it('50/50 ETF: one member doubles, one flat → +50% return', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('MSFT', '2024-01-01T21:00:00Z', 20000);
    await seedBar('AAPL', '2024-03-01T21:00:00Z', 20000);
    await seedBar('MSFT', '2024-03-01T21:00:00Z', 20000);

    await insertEtf({
      key: 'test50',
      name: 'Test 50/50',
      baseDate: '2024-01-01',
      baseValue: 10000,
      weights: { AAPL: 1, MSFT: 1 },
    });

    const { etfSeries } = await import('../../src/etf/series.js');
    const bars = await etfSeries(pool, 'test50', {
      from: '2024-01-01T00:00:00Z',
      to: '2024-03-31T00:00:00Z',
    });

    const t0 = bars.find((b) => b.ts.startsWith('2024-01-01'));
    const t1 = bars.find((b) => b.ts.startsWith('2024-03-01'));

    expect(t0).toBeDefined();
    expect(t1).toBeDefined();
    // base_value × (0.5 × 10000/10000 + 0.5 × 20000/20000) = 10000 × 1 = 10000
    expect(t0!.close).toBe(10000);
    // base_value × (0.5 × 20000/10000 + 0.5 × 20000/20000) = 10000 × 1.5 = 15000
    expect(t1!.close).toBe(15000);
    expect(((t1!.close - t0!.close) / t0!.close) * 100).toBeCloseTo(50, 5);
  });

  it('OHLC: open=high=low=close for synthetic bars', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('AAPL', '2024-02-01T21:00:00Z', 12000);

    await insertEtf({
      key: 'solo',
      name: 'Solo',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    });

    const { etfSeries } = await import('../../src/etf/series.js');
    const bars = await etfSeries(pool, 'solo', {
      from: '2024-01-01T00:00:00Z',
      to: '2024-02-28T00:00:00Z',
    });

    expect(bars.length).toBeGreaterThan(0);
    for (const b of bars) {
      expect(b.open).toBe(b.close);
      expect(b.high).toBe(b.close);
      expect(b.low).toBe(b.close);
      expect(b.volume).toBeNull();
    }
  });

  it('carry-forward: missing bar on a date uses last prior close', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('MSFT', '2024-01-01T21:00:00Z', 10000);
    // AAPL has bar on 01-03; MSFT carries forward at 10000.
    await seedBar('AAPL', '2024-01-03T21:00:00Z', 20000);

    await insertEtf({
      key: 'carry',
      name: 'Carry Forward',
      baseDate: '2024-01-01',
      baseValue: 10000,
      weights: { AAPL: 1, MSFT: 1 },
    });

    const { etfSeries } = await import('../../src/etf/series.js');
    const bars = await etfSeries(pool, 'carry', {
      from: '2024-01-01T00:00:00Z',
      to: '2024-01-05T00:00:00Z',
    });

    const t1 = bars.find((b) => b.ts.startsWith('2024-01-03'));
    // AAPL ratio = 20000/10000 = 2; MSFT carry = 10000/10000 = 1
    // level = 10000 × (0.5×2 + 0.5×1) = 15000
    expect(t1).toBeDefined();
    expect(t1!.close).toBe(15000);
  });

  it('rejects when a member has no bar at or before base_date', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-02-01T21:00:00Z', 10000); // bar is AFTER base_date

    await insertEtf({
      key: 'badbase',
      name: 'Bad Base',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    });

    const { etfSeries } = await import('../../src/etf/series.js');
    await expect(
      etfSeries(pool, 'badbase', {
        from: '2024-01-01T00:00:00Z',
        to: '2024-03-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('rejects when ETF key does not exist', async () => {
    const { etfSeries } = await import('../../src/etf/series.js');
    await expect(
      etfSeries(pool, 'nonexistent', {
        from: '2024-01-01T00:00:00Z',
        to: '2024-03-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it('returns empty array when no bars fall in the window', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);

    await insertEtf({
      key: 'empty',
      name: 'Empty',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    });

    const { etfSeries } = await import('../../src/etf/series.js');
    const bars = await etfSeries(pool, 'empty', {
      from: '2024-06-01T00:00:00Z',
      to: '2024-12-01T00:00:00Z',
    });
    expect(bars).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ETF CRUD (createEtf / loadEtf / listEtfs / getEtfReturns)
// ---------------------------------------------------------------------------

describe('createEtf', () => {
  it('creates an ETF and returns normalized weights', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('MSFT', '2024-01-01T21:00:00Z', 20000);

    const { createEtf } = await import('../../src/etf/crud.js');
    const etf = await createEtf(
      {
        key: 'big2',
        name: 'Big 2',
        baseDate: '2024-01-01',
        baseValue: 10000,
        weights: { AAPL: 1, MSFT: 3 },
      },
      pool,
    );

    expect(etf.key).toBe('big2');
    expect(etf.name).toBe('Big 2');
    expect(etf.baseValue).toBe(10000);
    expect(etf.weights).toHaveLength(2);

    // Weights normalize: 1+3 = 4; AAPL = 0.25, MSFT = 0.75
    const appl = etf.weights.find((w) => w.symbol === 'AAPL');
    const msft = etf.weights.find((w) => w.symbol === 'MSFT');
    expect(appl!.weight).toBeCloseTo(0.25, 5);
    expect(msft!.weight).toBeCloseTo(0.75, 5);

    // Weights sum to 1
    const total = etf.weights.reduce((s, w) => s + w.weight, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it('rejects when a member is not in universe', async () => {
    const { createEtf, EtfError } = await import('../../src/etf/crud.js');
    await expect(
      createEtf(
        {
          key: 'bad',
          name: 'Bad',
          baseDate: '2024-01-01',
          weights: { NOPE: 1 },
        },
        pool,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof EtfError && (e as EtfError).code === 'UNKNOWN_MEMBERS',
    );
  });

  it('rejects when a member is not backfilled', async () => {
    await seedSymbol('AAPL', false); // not backfilled
    const { createEtf, EtfError } = await import('../../src/etf/crud.js');
    await expect(
      createEtf(
        {
          key: 'nbf',
          name: 'Not Backfilled',
          baseDate: '2024-01-01',
          weights: { AAPL: 1 },
        },
        pool,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof EtfError && (e as EtfError).code === 'NOT_BACKFILLED',
    );
  });

  it('rejects when a member has no bar at or before baseDate', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-02-01T21:00:00Z', 10000);
    const { createEtf, EtfError } = await import('../../src/etf/crud.js');
    await expect(
      createEtf(
        {
          key: 'ub',
          name: 'Undefined Base',
          baseDate: '2024-01-01',
          weights: { AAPL: 1 },
        },
        pool,
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof EtfError && (e as EtfError).code === 'UNDEFINED_BASE',
    );
  });

  it('rejects on duplicate key', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    const { createEtf, EtfError } = await import('../../src/etf/crud.js');
    const input = {
      key: 'dup',
      name: 'Dup',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    };
    await createEtf(input, pool);
    await expect(createEtf(input, pool)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof EtfError && (e as EtfError).code === 'DUPLICATE_KEY',
    );
  });
});

describe('loadEtf', () => {
  it('returns ETF with normalized weights', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await insertEtf({
      key: 'load1',
      name: 'Load Test',
      baseDate: '2024-01-01',
      weights: { AAPL: 2, MSFT: 2 },
    });

    const { loadEtf } = await import('../../src/etf/crud.js');
    const etf = await loadEtf('load1', pool);

    expect(etf).not.toBeNull();
    expect(etf!.key).toBe('load1');
    expect(etf!.weights).toHaveLength(2);

    // Equal weights → both 0.5
    for (const w of etf!.weights) {
      expect(w.weight).toBeCloseTo(0.5, 5);
    }
  });

  it('returns null for unknown key', async () => {
    const { loadEtf } = await import('../../src/etf/crud.js');
    expect(await loadEtf('ghost', pool)).toBeNull();
  });
});

describe('listEtfs', () => {
  it('lists ETFs with correct member counts', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await insertEtf({
      key: 'a',
      name: 'A',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    });
    await insertEtf({
      key: 'b',
      name: 'B',
      baseDate: '2024-01-01',
      weights: { AAPL: 1, MSFT: 1 },
    });

    const { listEtfs } = await import('../../src/etf/crud.js');
    const items = await listEtfs(pool);

    expect(items).toHaveLength(2);
    const a = items.find((i) => i.key === 'a');
    const b = items.find((i) => i.key === 'b');
    expect(a!.memberCount).toBe(1);
    expect(b!.memberCount).toBe(2);
  });
});

describe('getEtfReturns', () => {
  it('returns correct returnPct over the window', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('AAPL', '2024-02-01T21:00:00Z', 12000);

    await insertEtf({
      key: 'ret',
      name: 'Returns',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    });

    const { getEtfReturns } = await import('../../src/etf/crud.js');
    const res = await getEtfReturns(
      'ret',
      '2024-01-01T00:00:00Z',
      '2024-02-28T00:00:00Z',
      pool,
    );

    // AAPL goes from 10000 to 12000 → +20%
    expect(res.returnPct).toBeCloseTo(20, 5);
  });

  it('returns null returnPct when fewer than 2 bars in window', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);

    await insertEtf({
      key: 'single',
      name: 'Single',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    });

    const { getEtfReturns } = await import('../../src/etf/crud.js');
    // Window with just one bar
    const res = await getEtfReturns(
      'single',
      '2024-01-01T00:00:00Z',
      '2024-01-02T00:00:00Z',
      pool,
    );
    expect(res.returnPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /prices — ETF handle support
// ---------------------------------------------------------------------------

describe('loadPrices with ETF handle', () => {
  it('returns synthetic series for etf:<key>', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('MSFT', '2024-01-01T21:00:00Z', 10000);
    await seedBar('AAPL', '2024-02-01T21:00:00Z', 20000);
    await seedBar('MSFT', '2024-02-01T21:00:00Z', 10000);

    await insertEtf({
      key: 'pricetest',
      name: 'Price Test',
      baseDate: '2024-01-01',
      baseValue: 10000,
      weights: { AAPL: 1, MSFT: 1 },
    });

    const { loadPrices } = await import('../../src/routes/prices.js');
    const res = await loadPrices({
      symbols: ['etf:pricetest'],
      from: '2024-01-01',
      to: '2024-02-28',
    });

    expect(res.series['etf:pricetest']).toBeDefined();
    const t1 = res.series['etf:pricetest']!.find((b) =>
      b.ts.startsWith('2024-02-01'),
    );
    expect(t1).toBeDefined();
    expect(t1!.close).toBe(15000); // AAPL doubles, MSFT flat → +50%
  });

  it('mixed real-symbol + ETF request works', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('MSFT', '2024-01-01T21:00:00Z', 10000);

    await insertEtf({
      key: 'mixed',
      name: 'Mixed',
      baseDate: '2024-01-01',
      weights: { MSFT: 1 },
    });

    const { loadPrices } = await import('../../src/routes/prices.js');
    const res = await loadPrices({
      symbols: ['AAPL', 'etf:mixed'],
      from: '2024-01-01',
      to: '2024-02-01',
    });

    expect(res.series['AAPL']).toBeDefined();
    expect(res.series['etf:mixed']).toBeDefined();
    expect(res.missing).toHaveLength(0);
  });

  it('unknown ETF handle lands in missing', async () => {
    const { loadPrices } = await import('../../src/routes/prices.js');
    const res = await loadPrices({
      symbols: ['etf:nosuchkey'],
      from: '2024-01-01',
      to: '2024-02-01',
    });
    expect(res.missing).toContain('etf:nosuchkey');
  });

  it('handle normalization: ETF:BIG7 → etf:big7', async () => {
    await seedSymbol('AAPL');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);

    await insertEtf({
      key: 'big7',
      name: 'Big 7',
      baseDate: '2024-01-01',
      weights: { AAPL: 1 },
    });

    const { loadPrices } = await import('../../src/routes/prices.js');
    const res = await loadPrices({
      symbols: ['ETF:BIG7'],
      from: '2024-01-01',
      to: '2024-02-01',
    });

    expect(res.series['etf:big7']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// /evaluate — ETF order fills
// ---------------------------------------------------------------------------

describe('replay with ETF order', () => {
  it('ETF order fills at point-in-time synthetic close', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('MSFT');
    await seedBar('AAPL', '2024-01-01T21:00:00Z', 10000);
    await seedBar('MSFT', '2024-01-01T21:00:00Z', 10000);
    await seedBar('AAPL', '2024-02-01T21:00:00Z', 20000);
    await seedBar('MSFT', '2024-02-01T21:00:00Z', 10000);

    await insertEtf({
      key: 'evaltest',
      name: 'Eval Test',
      baseDate: '2024-01-01',
      baseValue: 10000,
      weights: { AAPL: 1, MSFT: 1 },
    });

    const { replay } = await import('../../src/eval/replay.js');
    const res = await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'etf:evaltest',
          side: 'buy',
          quantity: 1,
          at: '2024-02-02T12:00:00Z',
        },
      ],
    });

    // Latest bar at 2024-02-01 → synthetic close = 15000
    expect(res.orders[0]!.status).toBe('filled');
    expect(res.orders[0]!.fillPrice).toBe(15000);
    expect(res.orders[0]!.symbol).toBe('etf:evaltest');
  });

  it('ETF order rejected as SYMBOL_NOT_TRADEABLE for unknown key', async () => {
    const { replay } = await import('../../src/eval/replay.js');
    const res = await replay({
      startingCash: 1_000_000,
      orders: [
        {
          symbol: 'etf:ghost',
          side: 'buy',
          quantity: 1,
          at: '2024-02-02T12:00:00Z',
        },
      ],
    });
    expect(res.orders[0]!.status).toBe('rejected');
    expect(res.orders[0]!.rejectReason).toBe('SYMBOL_NOT_TRADEABLE');
  });
});
