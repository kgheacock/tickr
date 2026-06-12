import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  seedOrder,
  nextPow2,
  computeBracket,
  type Entrant,
} from '../../src/fantasy/playoffs.js';
import { generateSchedule } from '../../src/fantasy/schedule.js';
import { settleMatchups } from '../../src/fantasy/settle.js';
import { loadSeason } from '../../src/fantasy/season.js';

pg.types.setTypeParser(20, Number);

// --- Pure bracket logic (no DB) ---------------------------------------------

describe('seedOrder / nextPow2', () => {
  it('builds standard single-elim seeding orders', () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('pads the field up to the next power of two', () => {
    expect([2, 3, 4, 5, 6, 8].map(nextPow2)).toEqual([2, 4, 4, 8, 8, 8]);
  });
});

function entrants(n: number): Entrant[] {
  return Array.from({ length: n }, (_, i) => ({
    userId: `u${i + 1}`,
    seed: i + 1,
  }));
}

describe('computeBracket', () => {
  it('seeds a 4-team bracket as 1v4 / 2v3, higher seed home', () => {
    const ranked = entrants(4);
    const { rounds, champion } = computeBracket(ranked, 4, () => null);
    expect(champion).toBeNull();
    expect(rounds).toHaveLength(1); // nothing settled yet
    expect(rounds[0]).toEqual([
      { home: { userId: 'u1', seed: 1 }, away: { userId: 'u4', seed: 4 } },
      { home: { userId: 'u2', seed: 2 }, away: { userId: 'u3', seed: 3 } },
    ]);
  });

  it('gives the top seeds first-round byes in a 6-team field', () => {
    const ranked = entrants(6);
    const { rounds } = computeBracket(ranked, 6, () => null);
    const r1 = rounds[0]!;
    // Seeds 1 and 2 sit (bye); 4v5 and 3v6 play.
    const byes = r1.filter((p) => p.away === null).map((p) => p.home.seed);
    expect(byes.sort()).toEqual([1, 2]);
    const games = r1
      .filter((p) => p.away !== null)
      .map((p) => [p.home.seed, p.away!.seed]);
    expect(games).toContainEqual([4, 5]);
    expect(games).toContainEqual([3, 6]);
  });

  it('advances single-elim to a champion once every game is decided', () => {
    const ranked = entrants(4);
    // Higher seed always wins.
    const winnerOf = (a: string, b: string): string => {
      const sa = ranked.find((e) => e.userId === a)!.seed;
      const sb = ranked.find((e) => e.userId === b)!.seed;
      return sa <= sb ? a : b;
    };
    const { rounds, champion } = computeBracket(ranked, 4, winnerOf);
    expect(rounds).toHaveLength(2); // round 1 + final
    // Final pairs the two semifinal winners: seed 1 vs seed 2.
    expect(rounds[1]).toEqual([
      { home: { userId: 'u1', seed: 1 }, away: { userId: 'u2', seed: 2 } },
    ]);
    expect(champion).toEqual({ userId: 'u1', seed: 1 });
  });

  it('lets a lower seed advance and re-seeds the next round by seed', () => {
    const ranked = entrants(4);
    // Seed 4 upsets seed 1; otherwise higher seed wins.
    const winnerOf = (a: string, b: string): string => {
      const pair = new Set([a, b]);
      if (pair.has('u1') && pair.has('u4')) return 'u4';
      const sa = ranked.find((e) => e.userId === a)!.seed;
      const sb = ranked.find((e) => e.userId === b)!.seed;
      return sa <= sb ? a : b;
    };
    const { rounds, champion } = computeBracket(ranked, 4, winnerOf);
    // Final: seed 2 is now the higher remaining seed, so it is home over seed 4.
    expect(rounds[1]).toEqual([
      { home: { userId: 'u2', seed: 2 }, away: { userId: 'u4', seed: 4 } },
    ]);
    expect(champion).toEqual({ userId: 'u2', seed: 2 });
  });
});

// --- End-to-end through settleMatchups (DB) ---------------------------------

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_playoffs_test')
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

beforeEach(async () => {
  await pool.query(
    `TRUNCATE fs_matchup, fs_standings, fs_weekly_score, fs_season,
              fs_league_member, fs_league RESTART IDENTITY CASCADE`,
  );
});

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, 'U', $2)`,
    [id, `${randomUUID()}@x.com`],
  );
  return id;
}

/** A 4-member active league with a 1-week regular season + season-1 row. */
async function seedLeague(): Promise<{ leagueId: string; users: string[] }> {
  const users = [
    await seedUser(),
    await seedUser(),
    await seedUser(),
    await seedUser(),
  ];
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 4, 1, '{}'::jsonb, 'open', 'active') RETURNING id`,
    [users[0]],
  );
  const leagueId = rows[0]!.id;
  for (const [i, u] of users.entries()) {
    await pool.query(
      `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
       VALUES ($1, $2, $3, $4)`,
      [leagueId, u, i === 0 ? 'commissioner' : 'manager', `T${i}`],
    );
  }
  await pool.query(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, playoff_seeds, started_at)
     VALUES ($1, 1, 'regular', 1, 4, now())`,
    [leagueId],
  );
  return { leagueId, users };
}

async function setScore(
  leagueId: string,
  userId: string,
  week: number,
  points: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO fs_weekly_score
       (league_id, user_id, season, week, total_points, season_id)
     VALUES ($1, $2, 1, $3, $4,
             (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))
     ON CONFLICT (league_id, user_id, season, week)
     DO UPDATE SET total_points = EXCLUDED.total_points`,
    [leagueId, userId, week, points],
  );
}

/** Seeds, in rank order, after the regular season settles. */
async function seedOrderUsers(leagueId: string): Promise<string[]> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM fs_standings WHERE league_id = $1 ORDER BY rank`,
    [leagueId],
  );
  return rows.map((r) => r.user_id);
}

async function playoffMatchups(
  leagueId: string,
  week: number,
): Promise<
  { home_user_id: string; away_user_id: string | null; round: number }[]
> {
  const { rows } = await pool.query<{
    home_user_id: string;
    away_user_id: string | null;
    round: number;
  }>(
    `SELECT home_user_id, away_user_id, round FROM fs_matchup
      WHERE league_id = $1 AND week = $2 AND is_playoff = true
      ORDER BY home_user_id`,
    [leagueId, week],
  );
  return rows;
}

describe('season → playoffs → champion (DB)', () => {
  it('seeds the bracket from standings, advances, and crowns the top seed', async () => {
    const { leagueId, users } = await seedLeague();
    await generateSchedule(pool, leagueId);

    // Distinct week-1 totals so the four final seeds are unambiguous.
    await setScore(leagueId, users[0]!, 1, 100);
    await setScore(leagueId, users[1]!, 1, 75);
    await setScore(leagueId, users[2]!, 1, 50);
    await setScore(leagueId, users[3]!, 1, 25);

    // Last regular week settles → playoffs open, round 1 seeded at week 2.
    const reg = await settleMatchups(pool, leagueId, 1);
    expect(reg.enteredPlayoffs).toBe(true);
    expect(reg.championUserId).toBeNull();

    const league = await pool.query<{ status: string }>(
      `SELECT status FROM fs_league WHERE id = $1`,
      [leagueId],
    );
    expect(league.rows[0]!.status).toBe('playoffs');

    const seeds = await seedOrderUsers(leagueId); // [seed1, seed2, seed3, seed4]
    expect(seeds).toHaveLength(4);
    const rankOf = new Map(seeds.map((u, i) => [u, i + 1]));

    const r1 = await playoffMatchups(leagueId, 2);
    expect(r1).toHaveLength(2);
    // Higher seed is home; the two games are 1v4 and 2v3.
    for (const m of r1) {
      const hs = rankOf.get(m.home_user_id)!;
      const as = rankOf.get(m.away_user_id!)!;
      expect(hs).toBeLessThan(as);
      expect(hs + as).toBe(5); // 1+4 and 2+3
    }

    // Both higher seeds win round 1.
    for (const m of r1) {
      await setScore(leagueId, m.home_user_id, 2, 100);
      await setScore(leagueId, m.away_user_id!, 2, 10);
    }
    const semi = await settleMatchups(pool, leagueId, 2);
    expect(semi.championUserId).toBeNull();

    const finals = await playoffMatchups(leagueId, 3);
    expect(finals).toHaveLength(1);
    const fin = finals[0]!;
    // The final pits seed 1 (home) against seed 2.
    expect(rankOf.get(fin.home_user_id)).toBe(1);
    expect(rankOf.get(fin.away_user_id!)).toBe(2);

    await setScore(leagueId, fin.home_user_id, 3, 100);
    await setScore(leagueId, fin.away_user_id!, 3, 90);
    const crowned = await settleMatchups(pool, leagueId, 3);
    expect(crowned.championUserId).toBe(seeds[0]);

    // The season and league are archived; the champion is recorded.
    const season = await loadSeason(pool, leagueId, 1);
    expect(season!.status).toBe('archived');
    expect(season!.champion_user_id).toBe(seeds[0]);
    expect(season!.ended_at).not.toBeNull();
    const after = await pool.query<{ status: string }>(
      `SELECT status FROM fs_league WHERE id = $1`,
      [leagueId],
    );
    expect(after.rows[0]!.status).toBe('archived');
  });

  it('keeps standings frozen across playoff settles (playoffs excluded)', async () => {
    const { leagueId, users } = await seedLeague();
    await generateSchedule(pool, leagueId);
    await setScore(leagueId, users[0]!, 1, 100);
    await setScore(leagueId, users[1]!, 1, 75);
    await setScore(leagueId, users[2]!, 1, 50);
    await setScore(leagueId, users[3]!, 1, 25);
    await settleMatchups(pool, leagueId, 1);

    const before = await pool.query(
      `SELECT user_id, wins, losses, rank FROM fs_standings
        WHERE league_id = $1 ORDER BY rank`,
      [leagueId],
    );

    // Settle a playoff week; regular-season standings must not move.
    const r1 = await playoffMatchups(leagueId, 2);
    for (const m of r1) {
      await setScore(leagueId, m.home_user_id, 2, 100);
      await setScore(leagueId, m.away_user_id!, 2, 10);
    }
    await settleMatchups(pool, leagueId, 2);

    const after = await pool.query(
      `SELECT user_id, wins, losses, rank FROM fs_standings
        WHERE league_id = $1 ORDER BY rank`,
      [leagueId],
    );
    expect(after.rows).toEqual(before.rows);
  });
});
