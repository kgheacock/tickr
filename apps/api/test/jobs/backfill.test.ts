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
import { Redis } from 'ioredis';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.Client;
let pool: pg.Pool;
let redis: Redis;

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

beforeAll(async () => {
  vi.stubEnv('ROLE', 'worker');
  vi.stubEnv('MASSIVE_API_KEY', process.env['MASSIVE_API_KEY'] ?? 'test-key');

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

  redis = new Redis(REDIS_URL);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await client?.end();
  await pool?.end();
  await container?.stop();
  await redis?.quit();
});

beforeEach(async () => {
  await client.query(`DELETE FROM price_bar`);
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

function makeBars(count: number, startMs: number) {
  return {
    status: 'OK',
    ticker: 'TEST',
    queryCount: count,
    resultsCount: count,
    results: Array.from({ length: count }, (_, i) => ({
      t: startMs + i * 24 * 60 * 60 * 1000,
      o: 150.0,
      h: 152.0,
      l: 149.0,
      c: 151.0,
      v: 1000,
    })),
  };
}

function makeEmpty() {
  return {
    status: 'OK',
    ticker: 'TEST',
    queryCount: 0,
    resultsCount: 0,
    results: [],
  };
}

describe('backfill', () => {
  it('skips symbols that are already backfilled', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAPL', true)`,
    );

    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(makeEmpty()), { status: 200 }),
      );

    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('marks symbol backfilled=true after all windows complete', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('MSFT', false)`,
    );

    const bars = makeBars(5, Date.now() - 90 * 24 * 60 * 60 * 1000);
    let firstCall = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(JSON.stringify(bars), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(makeEmpty()), { status: 200 }),
      );
    });

    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'MSFT'`,
    );
    expect(rows[0]?.backfilled).toBe(true);
  });

  it('crash mid-symbol: restart resumes and partial rows survive (ON CONFLICT)', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('GOOG', false)`,
    );

    const startMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
    // Page 1 carries a next_url; the crash happens when the client follows it,
    // after page 1's bars are already inserted.
    const page1 = {
      ...makeBars(3, startMs),
      next_url: 'https://api.massive.com/next',
    };

    let firstCall = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return Promise.resolve(
          new Response(JSON.stringify(page1), { status: 200 }),
        );
      }
      return Promise.reject(new Error('simulated crash'));
    });

    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    // A mid-symbol failure no longer aborts the whole run: the error is caught
    // per-symbol and the symbol is deferred (left backfilled = false) so the
    // next run retries it. The run itself resolves.
    await runBackfill(redis);

    const { rows: beforeRows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'GOOG'`,
    );
    expect(beforeRows[0]?.backfilled).toBe(false);

    const { rows: barRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'GOOG'`,
    );
    expect(Number(barRows[0]?.count)).toBe(3); // page 1 survived the crash

    // Second run (restart): single complete page (no next_url). ON CONFLICT
    // keeps the row count the same and the symbol is marked backfilled.
    vi.resetModules();
    const mockFetch2 = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(makeBars(3, startMs)), { status: 200 }),
      );
    vi.stubGlobal('fetch', mockFetch2);

    const { runBackfill: runBackfill2 } =
      await import('../../src/jobs/backfill.js');
    await runBackfill2(redis);

    const { rows: afterRows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'GOOG'`,
    );
    expect(Number(afterRows[0]?.count)).toBe(3); // no duplicates

    const { rows: finalRows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'GOOG'`,
    );
    expect(finalRows[0]?.backfilled).toBe(true);
  });
});

describe('backfill — masking, data_status, ticker, limit', () => {
  function respond(body: object) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }

  it('follows next_url across pages and inserts every page', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('PAGED', false)`,
    );
    const base = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const HOUR = 60 * 60 * 1000;
    // Three pages of 2 distinct bars each; only the first two carry a next_url.
    const pages = [
      { ...makeBars(2, base), next_url: 'https://api.massive.com/p2' },
      {
        ...makeBars(2, base + 2 * HOUR),
        next_url: 'https://api.massive.com/p3',
      },
      { ...makeBars(2, base + 4 * HOUR) }, // no next_url → last page
    ];
    let i = 0;
    const mockFetch = vi
      .fn()
      .mockImplementation(() => respond(pages[i++] ?? makeEmpty()));
    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    expect(mockFetch).toHaveBeenCalledTimes(3); // page1 + 2 next_url follows
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'PAGED'`,
    );
    expect(Number(rows[0]?.count)).toBe(6); // all three pages inserted
  });

  it('does NOT mark a zero-bar symbol backfilled (masking fix, Finding 4)', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('DEAD', false)`,
    );
    // Every window returns empty — the symbol has no data at the source.
    const mockFetch = vi.fn().mockImplementation(() => respond(makeEmpty()));
    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    const result = await runBackfill(redis);

    const { rows } = await client.query<{
      backfilled: boolean;
      data_status: string | null;
    }>(
      `SELECT backfilled, data_status FROM universe_symbol WHERE symbol = 'DEAD'`,
    );
    expect(rows[0]?.backfilled).toBe(false); // not falsely marked complete
    expect(rows[0]?.data_status).toBeNull();
    expect(result.failed).not.toContain('DEAD'); // empty != errored
  });

  it("marks a fully-covered symbol data_status = 'ok'", async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('FRESH', false)`,
    );
    // Newest bar is ~now → tail is current.
    const bars = makeBars(3, Date.now() - 2 * 24 * 60 * 60 * 1000);
    let first = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (first) {
        first = false;
        return respond(bars);
      }
      return respond(makeEmpty());
    });
    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    const { rows } = await client.query<{ data_status: string | null }>(
      `SELECT data_status FROM universe_symbol WHERE symbol = 'FRESH'`,
    );
    expect(rows[0]?.data_status).toBe('ok');
  });

  it("marks a stale-tailed symbol data_status = 'incomplete' (Findings 2B/2C)", async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('SHORT', false)`,
    );
    // Bars exist but the newest is ~400 days old: depth-capped at the source.
    const bars = makeBars(3, Date.now() - 400 * 24 * 60 * 60 * 1000);
    let first = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (first) {
        first = false;
        return respond(bars);
      }
      return respond(makeEmpty());
    });
    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    const { rows } = await client.query<{
      backfilled: boolean;
      data_status: string | null;
    }>(
      `SELECT backfilled, data_status FROM universe_symbol WHERE symbol = 'SHORT'`,
    );
    expect(rows[0]?.backfilled).toBe(true);
    expect(rows[0]?.data_status).toBe('incomplete');
  });

  it('requests the Massive ticker (period) and stores under the canonical hyphen', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('BRK-B', false)`,
    );
    const bars = makeBars(2, Date.now() - 2 * 24 * 60 * 60 * 1000);
    let first = true;
    const mockFetch = vi.fn().mockImplementation(() => {
      if (first) {
        first = false;
        return respond(bars);
      }
      return respond(makeEmpty());
    });
    vi.stubGlobal('fetch', mockFetch);

    const { runBackfill } = await import('../../src/jobs/backfill.js');
    await runBackfill(redis);

    const url = String(mockFetch.mock.calls[0]?.[0]);
    expect(url).toContain('/ticker/BRK.B/'); // translated for the API
    expect(url).toContain('limit=50000'); // requested page size (capped by tier)
    // Bars stored under the canonical hyphen symbol, not the API form.
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*) FROM price_bar WHERE symbol = 'BRK-B'`,
    );
    expect(Number(rows[0]?.count)).toBe(2);
  });
});

describe('widen-history (script-only re-arm)', () => {
  // nowMs is passed explicitly in every test so the stale-tail check is
  // deterministic (relative to a fixed "now", not the wall clock).
  async function seedBars(
    symbol: string,
    isos: string[],
    backfilled = true,
    dataStatus: string | null = null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled, data_status)
       VALUES ($1, $2, $3)`,
      [symbol, backfilled, dataStatus],
    );
    for (const iso of isos) {
      await client.query(
        `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
         VALUES ($1, $2, 15000, 15200, 14900, 15100, 1000)`,
        [symbol, iso],
      );
    }
  }

  it('re-arms a backfilled symbol whose history starts after the requested date', async () => {
    // Oldest bar (2022) is well after the requested 2015 start; newest is near
    // the supplied "now" so only the missing-early-history rule fires.
    await seedBars('IPO', ['2022-01-03T00:00:00Z']);

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2015-01-01T00:00:00Z'),
      Date.parse('2022-01-06T00:00:00Z'),
    );

    expect(reset).toBe(1);
    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'IPO'`,
    );
    expect(rows[0]?.backfilled).toBe(false);
  });

  it('leaves a symbol covered to the requested date (within tolerance) alone', async () => {
    // Earliest bar is 4 days after the requested start (weekend/holiday gap) and
    // the newest bar is at "now" — neither rule fires, so it stays backfilled.
    await seedBars('FULL', ['2015-01-05T00:00:00Z']);

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2015-01-01T00:00:00Z'),
      Date.parse('2015-01-05T00:00:00Z'),
    );

    expect(reset).toBe(0);
    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'FULL'`,
    );
    expect(rows[0]?.backfilled).toBe(true);
  });

  it('re-arms a backfilled symbol with ZERO bars (audit Finding 4)', async () => {
    // backfilled = true but no price_bar rows (wrong-ticker / delisted before
    // the ticker fix). The LEFT JOIN must catch it — an inner join could not.
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('NOBARS', true)`,
    );

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2024-06-09T00:00:00Z'),
      Date.parse('2026-06-09T00:00:00Z'),
    );

    expect(reset).toBe(1);
    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'NOBARS'`,
    );
    expect(rows[0]?.backfilled).toBe(false);
  });

  it('re-arms a symbol with a stale tail (Findings 2B/2C)', async () => {
    // Oldest bar reaches the start, but the newest bar is a year before "now" —
    // a one-year-only / near-zero-coverage symbol. The stale-tail rule fires.
    await seedBars('STALE', ['2024-06-10T14:00:00Z', '2025-06-10T14:00:00Z']);

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2024-06-09T00:00:00Z'),
      Date.parse('2026-06-09T00:00:00Z'),
    );

    expect(reset).toBe(1);
    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'STALE'`,
    );
    expect(rows[0]?.backfilled).toBe(false);
  });

  it('does NOT re-arm a terminal data_status = incomplete symbol (convergence)', async () => {
    // Same stale-tail shape, but already marked terminal by the backfill. Re-arm
    // must skip it or the bootstrap would loop forever.
    await seedBars(
      'CAPPED',
      ['2024-06-10T14:00:00Z', '2024-06-27T14:00:00Z'],
      true,
      'incomplete',
    );

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2024-06-09T00:00:00Z'),
      Date.parse('2026-06-09T00:00:00Z'),
    );

    expect(reset).toBe(0);
    const { rows } = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = 'CAPPED'`,
    );
    expect(rows[0]?.backfilled).toBe(true);
  });

  it('does not touch symbols that are not yet backfilled', async () => {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('PENDING', false)`,
    );

    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const reset = await resetSymbolsMissingHistory(
      Date.parse('2015-01-01T00:00:00Z'),
      Date.parse('2015-01-08T00:00:00Z'),
    );

    expect(reset).toBe(0);
  });
});

describe('prune-dead (script-only)', () => {
  async function seedBacked(symbol: string): Promise<void> {
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
      [symbol],
    );
    await client.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ($1, now(), 100, 110, 90, 105, 1000)`,
      [symbol],
    );
  }

  it('hard-removes a zero-bar, backfilled=false symbol', async () => {
    vi.stubEnv('BACKFILL_PRUNE_MAX_FRACTION', '1.0');
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('DEAD', false)`,
    );

    const { pruneDeadSymbols } = await import('../../src/jobs/prune-dead.js');
    const pruned = await pruneDeadSymbols([]);

    expect(pruned).toBe(1);
    const { rows } = await client.query(
      `SELECT 1 FROM universe_symbol WHERE symbol = 'DEAD'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('excludes symbols that failed transiently this run', async () => {
    vi.stubEnv('BACKFILL_PRUNE_MAX_FRACTION', '1.0');
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('FLAKY', false)`,
    );

    const { pruneDeadSymbols } = await import('../../src/jobs/prune-dead.js');
    const pruned = await pruneDeadSymbols(['FLAKY']);

    expect(pruned).toBe(0);
    const { rows } = await client.query(
      `SELECT 1 FROM universe_symbol WHERE symbol = 'FLAKY'`,
    );
    expect(rows).toHaveLength(1); // kept for retry
  });

  it('does not prune symbols that have bars', async () => {
    vi.stubEnv('BACKFILL_PRUNE_MAX_FRACTION', '1.0');
    // backfilled=false but with bars (e.g. re-armed mid-coverage) — not dead.
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('PARTIAL', false)`,
    );
    await client.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
       VALUES ('PARTIAL', now(), 100, 110, 90, 105, 1000)`,
    );

    const { pruneDeadSymbols } = await import('../../src/jobs/prune-dead.js');
    expect(await pruneDeadSymbols([])).toBe(0);
  });

  it('skips the prune when the dead fraction exceeds the guard (outage safety)', async () => {
    vi.stubEnv('BACKFILL_PRUNE_MAX_FRACTION', '0.25');
    await seedBacked('HEALTHY'); // 1 healthy
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('DEAD', false)`,
    ); // 1 dead of 2 total = 0.5 > 0.25

    const { pruneDeadSymbols } = await import('../../src/jobs/prune-dead.js');
    const pruned = await pruneDeadSymbols([]);

    expect(pruned).toBe(0);
    const { rows } = await client.query(
      `SELECT 1 FROM universe_symbol WHERE symbol = 'DEAD'`,
    );
    expect(rows).toHaveLength(1); // not deleted — guard tripped
  });
});

// Exercises the actual bootstrap sequence (run-backfill.ts): re-arm → backfill
// → prune, then the same sequence a SECOND time, to prove the end goal — no
// stale symbols, and convergence (no churn) for symbols not re-added by seed.
describe('bootstrap composition: re-arm → backfill → prune (×2)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  // Per-symbol mock keyed on the ticker in the request URL.
  function mockBySymbol(): ReturnType<typeof vi.fn> {
    return vi.fn().mockImplementation((url: string) => {
      let body: object = makeEmpty();
      if (url.includes('/ticker/HEALTHY/')) {
        body = makeBars(3, Date.now() - 2 * DAY); // newest ~now → 'ok'
      } else if (url.includes('/ticker/SHORT/')) {
        body = makeBars(3, Date.now() - 400 * DAY); // newest stale → 'incomplete'
      } // DEAD → empty
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    });
  }

  async function runSequence(): Promise<number> {
    vi.stubEnv('BACKFILL_PRUNE_MAX_FRACTION', '1.0');
    vi.stubGlobal('fetch', mockBySymbol());
    const { resetSymbolsMissingHistory } =
      await import('../../src/jobs/widen-history.js');
    const { runBackfill } = await import('../../src/jobs/backfill.js');
    const { pruneDeadSymbols } = await import('../../src/jobs/prune-dead.js');
    await resetSymbolsMissingHistory(
      Date.parse('2024-06-09T00:00:00Z'),
      Date.now(),
    );
    const { failed } = await runBackfill(redis);
    return pruneDeadSymbols(failed);
  }

  it('leaves no stale symbols and is stable across a second run', async () => {
    // All three start backfilled=true with stale/zero coverage (the audit's bad
    // state) so re-arm flips them and backfill re-attempts each.
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES
         ('HEALTHY', true), ('SHORT', true), ('DEAD', true)`,
    );
    for (const s of ['HEALTHY', 'SHORT']) {
      await client.query(
        `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
         VALUES ($1, '2024-06-10T14:00:00Z', 100, 110, 90, 105, 1000)`,
        [s],
      );
    }

    // ── Run 1 ──────────────────────────────────────────────────────────────
    const pruned1 = await runSequence();
    expect(pruned1).toBe(1); // DEAD removed

    const after1 = await client.query<{
      symbol: string;
      data_status: string | null;
    }>(`SELECT symbol, data_status FROM universe_symbol ORDER BY symbol`);
    expect(after1.rows).toEqual([
      { symbol: 'HEALTHY', data_status: 'ok' },
      { symbol: 'SHORT', data_status: 'incomplete' },
    ]); // DEAD gone, SHORT flagged, HEALTHY ok — no stale symbol remains

    // ── Run 2 (DEAD re-added, as seedUniverse would from the CSV) ───────────
    await client.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('DEAD', true)`,
    );
    const pruned2 = await runSequence();
    expect(pruned2).toBe(1); // re-added DEAD is re-pruned → end state still clean

    // HEALTHY/SHORT are a true fixed point: re-arm skips 'incomplete' and the
    // fresh 'ok' tail, so neither is re-fetched or changed.
    const after2 = await client.query<{
      symbol: string;
      data_status: string | null;
    }>(`SELECT symbol, data_status FROM universe_symbol ORDER BY symbol`);
    expect(after2.rows).toEqual([
      { symbol: 'HEALTHY', data_status: 'ok' },
      { symbol: 'SHORT', data_status: 'incomplete' },
    ]);
  });
});
