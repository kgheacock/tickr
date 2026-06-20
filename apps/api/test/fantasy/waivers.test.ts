import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { RosterConfig } from '@tickr/shared-types';
import {
  submitWaiverClaim,
  listWaivers,
  runWaivers,
} from '../../src/fantasy/waivers.js';
import { FantasyError } from '../../src/fantasy/leagues.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_waivers_test')
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
// the tests need no classification rows.
const ROSTER: RosterConfig = {
  slots: ['Anchor', 'Defense', 'Wildcard'],
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

/** An active 2-manager league. Returns league + the two member ids. */
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
  // FS-08: the season-1 row the lineup/score NOT NULL season_id FK resolves to.
  await pool.query(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, started_at)
     SELECT id, 1, 'regular', season_length_weeks, now()
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

/**
 * Give a manager a cumulative weekly total. Waiver priority is worst-first, and
 * "worst" is now the lowest cumulative weekly points (no standings), so a smaller
 * total claims earlier.
 */
async function setPoints(
  leagueId: string,
  userId: string,
  totalPoints: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO fs_weekly_score
       (league_id, user_id, season, week, total_points, season_id)
     VALUES ($1, $2, 1, 1, $3,
             (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))
     ON CONFLICT (league_id, user_id, season, week)
     DO UPDATE SET total_points = EXCLUDED.total_points`,
    [leagueId, userId, totalPoints],
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

beforeEach(async () => {
  await pool.query('DELETE FROM fs_waiver_claim');
  await pool.query('DELETE FROM fs_waiver_order');
  await pool.query('DELETE FROM fs_weekly_score');
  await pool.query('DELETE FROM fs_lineup');
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');
});

describe('submitWaiverClaim', () => {
  it('queues a pending claim for a free add and an owned drop', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'OLD');
    await seedSymbol('NEW');

    const claim = await submitWaiverClaim(pool, leagueId, a, {
      addSymbol: 'new',
      dropSymbol: 'old',
    });
    expect(claim).toMatchObject({
      addSymbol: 'NEW',
      dropSymbol: 'OLD',
      status: 'pending',
      isShort: false,
    });
  });

  it('rejects an add already owned in the league', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'OLD');
    await own(leagueId, b, 'TAKEN');
    await expect(
      submitWaiverClaim(pool, leagueId, a, {
        addSymbol: 'TAKEN',
        dropSymbol: 'OLD',
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_OWNED' });
  });

  it('rejects a drop the caller does not own', async () => {
    const { leagueId, a } = await seedLeague();
    await seedSymbol('NEW');
    await seedSymbol('NOTMINE');
    await expect(
      submitWaiverClaim(pool, leagueId, a, {
        addSymbol: 'NEW',
        dropSymbol: 'NOTMINE',
      }),
    ).rejects.toBeInstanceOf(FantasyError);
  });
});

describe('runWaivers', () => {
  it('awards a contested add to the worst-ranked claimant, demotes the winner', async () => {
    const { leagueId, a, b } = await seedLeague();
    // A leads on cumulative points, B trails → worst-first favors B.
    await setPoints(leagueId, a, 100);
    await setPoints(leagueId, b, 50);
    await own(leagueId, a, 'DA');
    await own(leagueId, b, 'DB');
    await seedSymbol('STAR');

    await submitWaiverClaim(pool, leagueId, a, {
      addSymbol: 'STAR',
      dropSymbol: 'DA',
    });
    await submitWaiverClaim(pool, leagueId, b, {
      addSymbol: 'STAR',
      dropSymbol: 'DB',
    });

    const result = await runWaivers(pool);
    expect(result).toMatchObject({ leagues: 1, awarded: 1 });

    // B (worst rank) won the contested add.
    expect(await ownerOf(leagueId, 'STAR')).toBe(b);
    // Roster size invariant: the add is paired with the drop.
    expect(await rosterOf(leagueId, b)).toEqual(['STAR']); // DB dropped, STAR added
    expect(await rosterOf(leagueId, a)).toEqual(['DA']); // unchanged loser

    // Claims resolved: B won, A lost.
    const aClaims = await listWaivers(pool, leagueId, a);
    const bClaims = await listWaivers(pool, leagueId, b);
    expect(aClaims.claims[0]!.status).toBe('lost');
    expect(bClaims.claims[0]!.status).toBe('won');

    // The winner is demoted behind the loser in the rolling order.
    const order = new Map(bClaims.order.map((o) => [o.userId, o.priority]));
    expect(order.get(b)!).toBeGreaterThan(order.get(a)!);
  });

  it('rolls priority within a run: a win demotes the same manager for later groups', async () => {
    const { leagueId, a, b } = await seedLeague();
    await setPoints(leagueId, a, 100); // most points → claims last
    await setPoints(leagueId, b, 50); // fewest points → claims first
    await own(leagueId, a, 'DA1');
    await own(leagueId, a, 'DA2');
    await own(leagueId, b, 'DB1');
    await own(leagueId, b, 'DB2');
    await seedSymbol('AAA');
    await seedSymbol('ZZZ');

    // Both managers contest both adds. Groups process alphabetically: AAA, ZZZ.
    await submitWaiverClaim(pool, leagueId, a, {
      addSymbol: 'AAA',
      dropSymbol: 'DA1',
    });
    await submitWaiverClaim(pool, leagueId, b, {
      addSymbol: 'AAA',
      dropSymbol: 'DB1',
    });
    await submitWaiverClaim(pool, leagueId, a, {
      addSymbol: 'ZZZ',
      dropSymbol: 'DA2',
    });
    await submitWaiverClaim(pool, leagueId, b, {
      addSymbol: 'ZZZ',
      dropSymbol: 'DB2',
    });

    const result = await runWaivers(pool);
    expect(result.awarded).toBe(2);

    // B wins AAA (was top priority); demoted, so A wins ZZZ.
    expect(await ownerOf(leagueId, 'AAA')).toBe(b);
    expect(await ownerOf(leagueId, 'ZZZ')).toBe(a);
  });

  it('marks a claim invalid when its drop is no longer owned at run time', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'OLD');
    await seedSymbol('NEW');
    await submitWaiverClaim(pool, leagueId, a, {
      addSymbol: 'NEW',
      dropSymbol: 'OLD',
    });
    // The drop leaves the roster before the run (e.g. an accepted trade).
    await pool.query(`DELETE FROM fs_roster_entry WHERE league_id = $1`, [
      leagueId,
    ]);

    await runWaivers(pool);
    const claims = await listWaivers(pool, leagueId, a);
    expect(claims.claims[0]!.status).toBe('invalid');
    expect(await ownerOf(leagueId, 'NEW')).toBeNull(); // not added
  });

  it('holds the window shut while a lineup is locked and unsettled', async () => {
    const { leagueId, a } = await seedLeague();
    await own(leagueId, a, 'OLD');
    await seedSymbol('NEW');
    await submitWaiverClaim(pool, leagueId, a, {
      addSymbol: 'NEW',
      dropSymbol: 'OLD',
    });

    // Lock a week with no weekly_score → the between-weeks window is closed.
    await pool.query(
      `INSERT INTO fs_lineup (league_id, user_id, season, week, locked_at, season_id)
       VALUES ($1, $2, 1, 1, now(),
               (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))`,
      [leagueId, a],
    );
    let result = await runWaivers(pool);
    expect(result).toMatchObject({ leagues: 0, awarded: 0 }); // skipped
    expect((await listWaivers(pool, leagueId, a)).claims[0]!.status).toBe(
      'pending',
    );

    // The week settles (weekly_score written) → window opens, claim resolves.
    await pool.query(
      `INSERT INTO fs_weekly_score
         (league_id, user_id, season, week, total_points, season_id)
       VALUES ($1, $2, 1, 1, 0,
               (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))`,
      [leagueId, a],
    );
    result = await runWaivers(pool);
    expect(result).toMatchObject({ leagues: 1, awarded: 1 });
    expect(await ownerOf(leagueId, 'NEW')).toBe(a);
  });
});
