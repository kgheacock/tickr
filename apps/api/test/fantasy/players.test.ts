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

  it('paginates with total/limit/offset', async () => {
    for (const s of ['AA', 'BB', 'CC', 'DD']) await seedSymbol(s);
    const page = await listPlayers(pool, leagueId, { limit: 2, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);
    expect(page.items.map((i) => i.symbol)).toEqual(['BB', 'CC']);
  });
});

describe('getPlayerDetail', () => {
  it('returns classification, price window, eligible slots, and ownership', async () => {
    await seedSymbol('NVDA');
    await seedClassification('NVDA', ['growth', 'defense', 'wildcard'], 20);
    await seedBar('NVDA', 1, 100);
    await seedBar('NVDA', 2, 110);

    const detail = await getPlayerDetail(pool, leagueId, 'nvda'); // case-insensitive
    expect(detail).not.toBeNull();
    expect(detail!.symbol).toBe('NVDA');
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
