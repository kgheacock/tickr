import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { RosterConfig } from '@tickr/shared-types';
import { addPlayer, dropPlayer } from '../../src/fantasy/roster.js';
import { FantasyError } from '../../src/fantasy/leagues.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_roster_test')
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

// Wildcard is a universal slot, so any backfilled symbol is a valid long add —
// the tests need no classification rows. Cap is two stocks (slots, bench 0).
const ROSTER: RosterConfig = {
  slots: ['Anchor', 'Wildcard'],
  bench: 0,
};

async function seedUser(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, $2, $3)`,
    [id, name, `${randomUUID()}@x.com`],
  );
  return id;
}

async function seedSymbol(symbol: string): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
    [symbol],
  );
}

/** An active 2-manager league with the season-1 row the lineup FK resolves to. */
async function seedLeague(): Promise<{
  leagueId: string;
  a: string;
  b: string;
}> {
  const a = await seedUser('A');
  const b = await seedUser('B');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 4, 12, $2::jsonb, 'open', 'active') RETURNING id`,
    [a, JSON.stringify(ROSTER)],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name, joined_at)
     VALUES ($1, $2, 'commissioner', 'TA', now()),
            ($1, $3, 'manager', 'TB', now() + interval '1 second')`,
    [leagueId, a, b],
  );
  await pool.query(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, playoff_seeds, started_at)
     SELECT id, 1, 'regular', season_length_weeks, LEAST(4, size), now()
       FROM fs_league WHERE id = $1`,
    [leagueId],
  );
  return { leagueId, a, b };
}

async function own(
  leagueId: string,
  userId: string,
  symbol: string,
  isShort = false,
): Promise<void> {
  await seedSymbol(symbol);
  await pool.query(
    `INSERT INTO fs_roster_entry (league_id, user_id, symbol, is_short, acquired_via)
     VALUES ($1, $2, $3, $4, 'draft')`,
    [leagueId, userId, symbol, isShort],
  );
}

async function ownerOf(
  leagueId: string,
  symbol: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM fs_roster_entry WHERE league_id = $1 AND symbol = $2`,
    [leagueId, symbol],
  );
  return rows[0]?.user_id ?? null;
}

async function rosterOf(leagueId: string, userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM fs_roster_entry
      WHERE league_id = $1 AND user_id = $2 ORDER BY symbol`,
    [leagueId, userId],
  );
  return rows.map((r) => r.symbol);
}

/** Lock a week with no weekly_score → the between-weeks window is closed. */
async function lockWeek(leagueId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO fs_lineup (league_id, user_id, season, week, locked_at, season_id)
     VALUES ($1, $2, 1, 1, now(),
             (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))`,
    [leagueId, userId],
  );
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_weekly_score');
  await pool.query('DELETE FROM fs_lineup');
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');
});

describe('addPlayer (buy)', () => {
  it('adds a free stock when the roster has room', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'OLD'); // one of two slots filled
    await seedSymbol('NEW');

    const res = await addPlayer(pool, leagueId, a, { addSymbol: 'new' });
    expect(res).toEqual({ leagueId, added: 'NEW', dropped: null });
    expect(await rosterOf(leagueId, a)).toEqual(['NEW', 'OLD']);
  });

  it('requires a drop when the roster is full', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'AAA');
    await own(leagueId, a, 'BBB'); // cap of 2 reached
    await seedSymbol('NEW');

    await expect(
      addPlayer(pool, leagueId, a, { addSymbol: 'NEW' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await rosterOf(leagueId, a)).toEqual(['AAA', 'BBB']);
  });

  it('swaps add for drop atomically when full', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'AAA');
    await own(leagueId, a, 'BBB');
    await seedSymbol('NEW');

    const res = await addPlayer(pool, leagueId, a, {
      addSymbol: 'NEW',
      dropSymbol: 'aaa',
    });
    expect(res).toEqual({ leagueId, added: 'NEW', dropped: 'AAA' });
    expect(await rosterOf(leagueId, a)).toEqual(['BBB', 'NEW']);
  });

  it('rejects an add already owned in the league', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'OLD');
    await own(leagueId, b, 'TAKEN');

    await expect(
      addPlayer(pool, leagueId, a, { addSymbol: 'TAKEN' }),
    ).rejects.toMatchObject({ code: 'ALREADY_OWNED' });
  });

  it('rejects a drop the caller does not own', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'AAA');
    await own(leagueId, a, 'BBB');
    await own(leagueId, b, 'THEIRS');
    await seedSymbol('NEW');

    await expect(
      addPlayer(pool, leagueId, a, { addSymbol: 'NEW', dropSymbol: 'THEIRS' }),
    ).rejects.toBeInstanceOf(FantasyError);
    // The add must not have landed despite the bad drop.
    expect(await ownerOf(leagueId, 'NEW')).toBeNull();
  });

  it('is rejected while the lineup is locked and unsettled', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'OLD');
    await seedSymbol('NEW');
    await lockWeek(leagueId, a);

    await expect(
      addPlayer(pool, leagueId, a, { addSymbol: 'NEW' }),
    ).rejects.toMatchObject({ code: 'LINEUP_LOCKED' });
    expect(await ownerOf(leagueId, 'NEW')).toBeNull();
  });
});

describe('dropPlayer (sell)', () => {
  it('drops an owned stock and opens the roster spot', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'AAA');
    await own(leagueId, a, 'BBB');

    const res = await dropPlayer(pool, leagueId, a, 'aaa');
    expect(res).toEqual({ leagueId, added: null, dropped: 'AAA' });
    expect(await rosterOf(leagueId, a)).toEqual(['BBB']);
  });

  it('rejects selling a stock the caller does not own', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, b, 'THEIRS');

    await expect(dropPlayer(pool, leagueId, a, 'THEIRS')).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
    expect(await ownerOf(leagueId, 'THEIRS')).toBe(b);
  });

  it('is rejected while the lineup is locked and unsettled', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'AAA');
    await lockWeek(leagueId, a);

    await expect(dropPlayer(pool, leagueId, a, 'AAA')).rejects.toMatchObject({
      code: 'LINEUP_LOCKED',
    });
    expect(await ownerOf(leagueId, 'AAA')).toBe(a);
  });
});
