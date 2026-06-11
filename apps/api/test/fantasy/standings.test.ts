import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  computeStandings,
  type StandingMatchup,
} from '../../src/fantasy/standings.js';
import { decideWinner, settleMatchups } from '../../src/fantasy/settle.js';
import { generateSchedule } from '../../src/fantasy/schedule.js';

pg.types.setTypeParser(20, Number);

/** A `final` head-to-head; `winnerUserId` null means a tie. */
function game(
  home: string,
  away: string | null,
  homePoints: number | null,
  awayPoints: number | null,
  winner: string | null,
): StandingMatchup {
  return {
    homeUserId: home,
    awayUserId: away,
    homePoints,
    awayPoints,
    winnerUserId: winner,
    status: 'final',
  };
}

describe('decideWinner', () => {
  it('higher total wins, equal totals tie', () => {
    expect(decideWinner('h', 'a', 50, 30)).toBe('h');
    expect(decideWinner('h', 'a', 30, 50)).toBe('a');
    expect(decideWinner('h', 'a', 40, 40)).toBeNull();
  });
});

describe('computeStandings', () => {
  it('aggregates wins/losses/points from final matchups', () => {
    const s = computeStandings(
      ['a', 'b'],
      [game('a', 'b', 30, 10, 'a'), game('b', 'a', 25, 20, 'b')],
    );
    const a = s.find((r) => r.userId === 'a')!;
    const b = s.find((r) => r.userId === 'b')!;
    expect(a).toMatchObject({ wins: 1, losses: 1, ties: 0 });
    expect(a.pointsFor).toBe(50); // 30 + 20
    expect(a.pointsAgainst).toBe(35); // 10 + 25
    expect(b).toMatchObject({ wins: 1, losses: 1, ties: 0 });
  });

  it('records ties on both sides', () => {
    const s = computeStandings(['a', 'b'], [game('a', 'b', 40, 40, null)]);
    expect(s.find((r) => r.userId === 'a')).toMatchObject({
      wins: 0,
      losses: 0,
      ties: 1,
    });
    expect(s.find((r) => r.userId === 'b')).toMatchObject({ ties: 1 });
  });

  it('treats a bye as a no-contest (no record, no points)', () => {
    const s = computeStandings(['a'], [game('a', null, 99, null, null)]);
    expect(s[0]).toMatchObject({
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
    });
  });

  it('ranks by win% then points-for', () => {
    // a 2-0; then c 1-1 (PF 45) outranks b 1-1 (PF 30) on points-for; d 0-2.
    const s = computeStandings(
      ['a', 'b', 'c', 'd'],
      [
        game('a', 'd', 50, 10, 'a'),
        game('a', 'c', 40, 20, 'a'), // c: PF 20, PA 40
        game('b', 'd', 30, 5, 'b'), // b: PF 30, win
        game('b', 'c', 0, 25, 'c'), // c: +25 → PF 45, win → 1-1
      ],
    );
    expect(s.map((r) => r.userId)).toEqual(['a', 'c', 'b', 'd']);
    s.forEach((r, i) => expect(r.rank).toBe(i + 1));
  });

  it('breaks a 2-way win%/points-for tie by head-to-head', () => {
    // ids chosen so a *follows* b alphabetically — proving H2H, not user_id,
    // is the decider when both sit at 1-1 with identical points-for.
    const a = 'zeta';
    const b = 'alpha';
    const c = 'm-c';
    const d = 'm-d';
    const s = computeStandings(
      [a, b, c, d],
      [
        game(a, b, 10, 5, a), // a beats b head-to-head
        game(a, c, 5, 10, c), // a loses → a is 1-1, PF 15
        game(b, d, 10, 5, b), // b wins → b is 1-1, PF 15
      ],
    );
    const ai = s.findIndex((r) => r.userId === a);
    const bi = s.findIndex((r) => r.userId === b);
    expect(ai).toBeLessThan(bi); // a outranks b on the head-to-head win
  });

  it('is deterministic for a head-to-head cycle (falls through, no throw)', () => {
    // a>b>c>a, all 1-1 / equal points — the comparator must stay total.
    const cyc = [
      game('a', 'b', 12, 8, 'a'),
      game('b', 'c', 12, 8, 'b'),
      game('c', 'a', 12, 8, 'c'),
    ];
    const order1 = computeStandings(['a', 'b', 'c'], cyc).map((r) => r.userId);
    const order2 = computeStandings(['c', 'b', 'a'], cyc).map((r) => r.userId);
    expect(order1).toEqual(order2); // independent of input order
    expect(new Set(order1).size).toBe(3);
  });
});

// --- DB-backed: schedule generation + settlement + re-score ------------------

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_standings_test')
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

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, $2, $3)`,
    [id, 'M', `${id}@x.com`],
  );
  return id;
}

/** A 4-manager active league, 3-week season. Returns league + member ids. */
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
     VALUES ('L', $1, 4, 3, '{}'::jsonb, 'open', 'active') RETURNING id`,
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
  return { leagueId, users };
}

async function setScore(
  leagueId: string,
  userId: string,
  week: number,
  points: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO fs_weekly_score (league_id, user_id, season, week, total_points)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (league_id, user_id, season, week)
     DO UPDATE SET total_points = EXCLUDED.total_points`,
    [leagueId, userId, week, points],
  );
}

interface DbMatchup {
  home_user_id: string;
  away_user_id: string | null;
  home_points: number | null;
  away_points: number | null;
  winner_user_id: string | null;
  status: string;
}

async function weekMatchups(
  leagueId: string,
  week: number,
): Promise<DbMatchup[]> {
  const { rows } = await pool.query<DbMatchup>(
    `SELECT home_user_id, away_user_id,
            home_points::float8 AS home_points,
            away_points::float8 AS away_points,
            winner_user_id, status
       FROM fs_matchup
      WHERE league_id = $1 AND season = 1 AND week = $2
      ORDER BY home_user_id`,
    [leagueId, week],
  );
  return rows;
}

describe('generateSchedule (DB)', () => {
  it('lays out a full round-robin once and is idempotent', async () => {
    const { leagueId } = await seedLeague();
    const inserted = await generateSchedule(pool, leagueId);
    expect(inserted).toBe(6); // 4 managers × 3 weeks ÷ 2 = 6 matchups

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM fs_matchup WHERE league_id = $1`,
      [leagueId],
    );
    expect(Number(rows[0]!.n)).toBe(6);

    // Re-running inserts nothing.
    expect(await generateSchedule(pool, leagueId)).toBe(0);
    const again = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM fs_matchup WHERE league_id = $1`,
      [leagueId],
    );
    expect(Number(again.rows[0]!.n)).toBe(6);
  });
});

describe('settleMatchups (DB)', () => {
  it('settles a week, ranks standings, and re-settles on a re-score', async () => {
    const { leagueId } = await seedLeague();
    await generateSchedule(pool, leagueId);

    // Make every week-1 home side win big; settle.
    const week1 = await weekMatchups(leagueId, 1);
    expect(week1).toHaveLength(2);
    for (const m of week1) {
      await setScore(leagueId, m.home_user_id, 1, 100);
      if (m.away_user_id) await setScore(leagueId, m.away_user_id, 1, 50);
    }
    const settled = await settleMatchups(pool, leagueId, 1);
    expect(settled).toBe(2);

    const after = await weekMatchups(leagueId, 1);
    after.forEach((m) => {
      expect(m.status).toBe('final');
      expect(m.winner_user_id).toBe(m.home_user_id); // higher score wins
      expect(m.home_points).toBe(100);
      expect(m.away_points).toBe(50);
    });

    const homeWinners = week1.map((m) => m.home_user_id);
    const standings = await pool.query<{
      user_id: string;
      wins: number;
      losses: number;
      rank: number;
    }>(
      `SELECT user_id, wins, losses, rank FROM fs_standings
        WHERE league_id = $1 ORDER BY rank`,
      [leagueId],
    );
    expect(standings.rows).toHaveLength(4);
    // Two 1-0 winners rank ahead of two 0-1 losers.
    standings.rows.slice(0, 2).forEach((r) => {
      expect(homeWinners).toContain(r.user_id);
      expect(r).toMatchObject({ wins: 1, losses: 0 });
    });
    standings.rows.slice(2).forEach((r) => {
      expect(r).toMatchObject({ wins: 0, losses: 1 });
    });

    // Re-score: flip the first matchup so the away side now wins, re-settle.
    const flip = week1[0]!;
    await setScore(leagueId, flip.home_user_id, 1, 10);
    await setScore(leagueId, flip.away_user_id!, 1, 90);
    await settleMatchups(pool, leagueId, 1);

    const reMatch = (await weekMatchups(leagueId, 1)).find(
      (m) => m.home_user_id === flip.home_user_id,
    )!;
    expect(reMatch.winner_user_id).toBe(flip.away_user_id); // result flipped
    expect(reMatch.home_points).toBe(10);

    // Standings re-ranked: the new winner is now 1-0, the old winner 0-1.
    const reStand = await pool.query<{ wins: number; losses: number }>(
      `SELECT wins, losses FROM fs_standings WHERE league_id = $1 AND user_id = $2`,
      [leagueId, flip.home_user_id],
    );
    expect(reStand.rows[0]).toMatchObject({ wins: 0, losses: 1 });
    const newWinner = await pool.query<{ wins: number; losses: number }>(
      `SELECT wins, losses FROM fs_standings WHERE league_id = $1 AND user_id = $2`,
      [leagueId, flip.away_user_id],
    );
    expect(newWinner.rows[0]).toMatchObject({ wins: 1, losses: 0 });
  });
});
