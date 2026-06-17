import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  listPlayers,
  getPlayerDetail,
} from '../../src/routes/leagues/players.js';
import { isEligible, slotsFor } from '../../src/fantasy/eligibility.js';
import {
  lastCompletedWeek,
  recentCompletedWeeks,
} from '../../src/fantasy/returns.js';
import type { PlayerGroup } from '@tickr/shared-types';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let leagueId: string;
let commishId: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_players_test')
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
  pool = new pg.Pool({ connectionString });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedSymbol(symbol: string): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
    [symbol],
  );
}

async function seedClassification(
  symbol: string,
  groups: PlayerGroup[],
  ret3mPct: number,
): Promise<void> {
  const metrics = JSON.stringify({
    ret3mPct,
    ret12mPct: ret3mPct * 2,
    sigma: 0.02,
    avgVolume: 1000,
  });
  for (const group of groups) {
    await pool.query(
      `INSERT INTO fs_player_classification (symbol, "group", eligible, metrics)
       VALUES ($1, $2, true, $3::jsonb)`,
      [symbol, group, metrics],
    );
  }
}

async function seedMetadata(symbol: string, name: string): Promise<void> {
  await pool.query(
    `INSERT INTO symbol_metadata (symbol, massive_ticker, name) VALUES ($1, $1, $2)`,
    [symbol, name],
  );
}

async function seedBar(
  symbol: string,
  day: number,
  close: number,
): Promise<void> {
  const ts = new Date(Date.UTC(2026, 0, day)).toISOString();
  await pool.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $3, $3, $3, 500)`,
    [symbol, ts, close],
  );
}

async function seedBarAt(
  symbol: string,
  ts: Date,
  close: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
     VALUES ($1, $2, $3, $3, $3, $3, 500)`,
    [symbol, ts.toISOString(), close],
  );
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM fs_player_classification');
  await pool.query('DELETE FROM price_bar');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');

  commishId = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, 'Boss', 'boss@x.com')`,
    [commishId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy)
     VALUES ('L', $1, 6, 12, '{"slots":["Anchor"],"bench":2}'::jsonb, 'open')
     RETURNING id`,
    [commishId],
  );
  leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'commissioner', 'Bulls')`,
    [leagueId, commishId],
  );
});

describe('listPlayers', () => {
  it('lists the corpus with groups, recent return, and ownership', async () => {
    await seedSymbol('GROW');
    await seedSymbol('SHRT');
    await seedClassification('GROW', ['growth', 'defense', 'wildcard'], 12);
    await seedClassification('SHRT', ['defense', 'wildcard'], -5);
    await seedMetadata('GROW', 'Growthly Inc.');
    // SHRT owned by the commissioner as a short.
    await pool.query(
      `INSERT INTO fs_roster_entry (league_id, user_id, symbol, is_short, acquired_via)
       VALUES ($1, $2, 'SHRT', true, 'draft')`,
      [leagueId, commishId],
    );

    const page = await listPlayers(pool, leagueId);
    expect(page.total).toBe(2);
    const grow = page.items.find((i) => i.symbol === 'GROW')!;
    const shrt = page.items.find((i) => i.symbol === 'SHRT')!;

    expect(grow.groups).toEqual(expect.arrayContaining(['growth', 'defense']));
    expect(grow.name).toBe('Growthly Inc.');
    // No metadata row → name is null, not an error.
    expect(shrt.name).toBeNull();
    expect(grow.recentReturnPct).toBeCloseTo(12, 6);
    expect(grow.ownership).toEqual({
      owned: false,
      ownerTeam: null,
      isShort: null,
    });
    expect(shrt.ownership).toEqual({
      owned: true,
      ownerTeam: 'Bulls',
      isShort: true,
    });
  });

  it('?available excludes owned; ?group and ?q filter', async () => {
    await seedSymbol('AAPL');
    await seedSymbol('AMZN');
    await seedSymbol('MSFT');
    await seedClassification('AAPL', ['growth', 'defense', 'wildcard'], 8);
    await seedClassification('AMZN', ['value', 'defense', 'wildcard'], -3);
    await seedClassification('MSFT', ['growth', 'defense', 'wildcard'], 6);
    await pool.query(
      `INSERT INTO fs_roster_entry (league_id, user_id, symbol, is_short, acquired_via)
       VALUES ($1, $2, 'MSFT', false, 'draft')`,
      [leagueId, commishId],
    );

    const available = await listPlayers(pool, leagueId, { available: true });
    expect(available.items.map((i) => i.symbol).sort()).toEqual([
      'AAPL',
      'AMZN',
    ]);

    const growth = await listPlayers(pool, leagueId, { group: 'growth' });
    expect(growth.items.map((i) => i.symbol).sort()).toEqual(['AAPL', 'MSFT']);

    const q = await listPlayers(pool, leagueId, { q: 'am' });
    expect(q.items.map((i) => i.symbol)).toEqual(['AMZN']);
  });

  it('?mine returns only the caller’s owned players', async () => {
    const otherId = randomUUID();
    await pool.query(
      `INSERT INTO app_user (id, display_name, email) VALUES ($1, 'Rival', 'rival@x.com')`,
      [otherId],
    );
    await pool.query(
      `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
       VALUES ($1, $2, 'manager', 'Bears')`,
      [leagueId, otherId],
    );
    await seedSymbol('MINE');
    await seedSymbol('THEIRS');
    await seedSymbol('FREE');
    // Exclusive ownership: MINE is the caller's, THEIRS is the rival's.
    await pool.query(
      `INSERT INTO fs_roster_entry (league_id, user_id, symbol, is_short, acquired_via)
       VALUES ($1, $2, 'MINE', false, 'draft'), ($1, $3, 'THEIRS', false, 'draft')`,
      [leagueId, commishId, otherId],
    );

    const mine = await listPlayers(pool, leagueId, {
      mine: true,
      userId: commishId,
    });
    expect(mine.items.map((i) => i.symbol)).toEqual(['MINE']);
    expect(mine.total).toBe(1);
  });

  it('reports lastWeekPoints from the last completed week (return)', async () => {
    // A fixed weekday clock so the "last completed week" anchors are stable.
    const now = new Date('2026-06-15T12:00:00Z');
    const { weekEnd, baselineAt } = lastCompletedWeek(now);

    await seedSymbol('UP');
    await seedSymbol('NODATA');
    // 100 → 110 over the week is +10%, scoring +10 long-basis points.
    await seedBarAt('UP', baselineAt, 100);
    await seedBarAt('UP', weekEnd, 110);

    const page = await listPlayers(pool, leagueId, { now });
    const up = page.items.find((i) => i.symbol === 'UP')!;
    const nodata = page.items.find((i) => i.symbol === 'NODATA')!;
    expect(up.lastWeekPoints).toBeCloseTo(10, 6);
    // No bars in the window → null, not a misleading zero.
    expect(nodata.lastWeekPoints).toBeNull();
  });

  it('paginates with total/limit/offset', async () => {
    for (const s of ['AA', 'BB', 'CC', 'DD']) await seedSymbol(s);
    const page = await listPlayers(pool, leagueId, { limit: 2, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);
    expect(page.items.map((i) => i.symbol)).toEqual(['BB', 'CC']);
  });

  it('sorts by symbol ascending and descending', async () => {
    for (const s of ['AA', 'BB', 'CC']) await seedSymbol(s);
    const asc = await listPlayers(pool, leagueId, { sort: 'symbol', dir: 'asc' });
    expect(asc.items.map((i) => i.symbol)).toEqual(['AA', 'BB', 'CC']);
    const desc = await listPlayers(pool, leagueId, {
      sort: 'symbol',
      dir: 'desc',
    });
    expect(desc.items.map((i) => i.symbol)).toEqual(['CC', 'BB', 'AA']);
  });

  it('sorts by last-week move, with no-data symbols always last', async () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const { weekEnd, baselineAt } = lastCompletedWeek(now);
    await seedSymbol('BIG'); // +20%
    await seedSymbol('SMALL'); // -10%
    await seedSymbol('NONE'); // no bars → null move
    await seedBarAt('BIG', baselineAt, 100);
    await seedBarAt('BIG', weekEnd, 120);
    await seedBarAt('SMALL', baselineAt, 100);
    await seedBarAt('SMALL', weekEnd, 90);

    const desc = await listPlayers(pool, leagueId, {
      sort: 'lastWk',
      dir: 'desc',
      now,
    });
    expect(desc.items.map((i) => i.symbol)).toEqual(['BIG', 'SMALL', 'NONE']);

    // NULLS LAST holds in both directions, so NONE stays at the end.
    const asc = await listPlayers(pool, leagueId, {
      sort: 'lastWk',
      dir: 'asc',
      now,
    });
    expect(asc.items.map((i) => i.symbol)).toEqual(['SMALL', 'BIG', 'NONE']);
  });
});

describe('getPlayerDetail', () => {
  it('returns classification, price window, eligible slots, and ownership', async () => {
    await seedSymbol('NVDA');
    await seedClassification('NVDA', ['growth', 'defense', 'wildcard'], 20);
    await seedMetadata('NVDA', 'NVIDIA Corporation');
    await seedBar('NVDA', 1, 100);
    await seedBar('NVDA', 2, 110);

    // Anchor the 3-month price window to the seeded bars so the chart slice is
    // deterministic regardless of wall-clock date.
    const now = new Date('2026-01-15T00:00:00Z');
    const detail = await getPlayerDetail(pool, leagueId, 'nvda', now); // case-insensitive
    expect(detail).not.toBeNull();
    expect(detail!.symbol).toBe('NVDA');
    expect(detail!.name).toBe('NVIDIA Corporation');
    expect(detail!.groups).toEqual(
      expect.arrayContaining(['growth', 'defense', 'wildcard']),
    );
    expect(detail!.eligibleSlots).toEqual(
      expect.arrayContaining(['Growth', 'Defense', 'Wildcard']),
    );
    expect(detail!.metrics.ret3mPct).toBeCloseTo(20, 6);
    expect(detail!.prices).toHaveLength(2);
    expect(detail!.prices[1]!.close).toBe(110);
    expect(detail!.ownership.owned).toBe(false);
  });

  it('builds scoringHistory whose newest week agrees with lastWeekPoints', async () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const weeks = recentCompletedWeeks(now, 3);
    await seedSymbol('HIST');
    // Three consecutive Friday closes: weeks share the boundary close, so two
    // completed weeks resolve (the third's baseline falls before any bar).
    await seedBarAt('HIST', weeks[1]!.baselineAt, 105); // F-21
    await seedBarAt('HIST', weeks[0]!.baselineAt, 100); // F-14
    await seedBarAt('HIST', weeks[0]!.weekEnd, 110); // F-7

    const detail = await getPlayerDetail(pool, leagueId, 'HIST', now);
    expect(detail).not.toBeNull();
    // SCORING_HISTORY_WEEKS entries, newest first.
    expect(detail!.scoringHistory).toHaveLength(8);
    expect(detail!.scoringHistory[0]!.points).toBeCloseTo(10, 6); // +10% → +10
    expect(detail!.scoringHistory[1]!.points).toBeCloseTo(-4.76, 2); // 105→100
    expect(detail!.scoringHistory[2]!.points).toBeNull(); // no baseline bar

    // The detail's newest week must match the inventory column for the same now.
    const page = await listPlayers(pool, leagueId, { now });
    const hist = page.items.find((i) => i.symbol === 'HIST')!;
    expect(hist.lastWeekPoints).toBeCloseTo(
      detail!.scoringHistory[0]!.points!,
      6,
    );
  });

  it('returns null for an unknown symbol', async () => {
    expect(await getPlayerDetail(pool, leagueId, 'GHOST')).toBeNull();
  });
});

describe('eligibility helper', () => {
  it('defense and wildcard are universal even for an unclassified symbol', async () => {
    await seedSymbol('ANY');
    expect(await isEligible(pool, 'ANY', 'defense')).toBe(true);
    expect(await isEligible(pool, 'ANY', 'Wildcard')).toBe(true);
    // Not classified for growth → not eligible.
    expect(await isEligible(pool, 'ANY', 'growth')).toBe(false);
    const slots = await slotsFor(pool, 'ANY');
    expect(slots).toEqual(expect.arrayContaining(['Defense', 'Wildcard']));
  });

  it('reflects stored classification for non-universal slots', async () => {
    await seedSymbol('GG');
    await seedClassification('GG', ['growth', 'defense', 'wildcard'], 5);
    expect(await isEligible(pool, 'GG', 'growth')).toBe(true);
    expect(await isEligible(pool, 'GG', 'value')).toBe(false);
    expect(await slotsFor(pool, 'GG')).toEqual(
      expect.arrayContaining(['Growth', 'Defense', 'Wildcard']),
    );
  });
});
