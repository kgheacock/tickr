import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Redis } from 'ioredis';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type {
  RosterConfig,
  ScoreBreakdownItem,
  WeeklyScore,
  RecapPayload,
} from '@tickr/shared-types';
import { buildRecap, generateLeagueRecaps } from '../../src/fantasy/recap.js';
import { RECAP_READY_CHANNEL } from '../../src/events/publisher.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

// --- Pure buildRecap (no DB) ------------------------------------------------

function score(userId: string, total: number, points: number[]): WeeklyScore {
  const breakdown: ScoreBreakdownItem[] = points.map((p, i) => ({
    slot: (['anchor', 'growth', 'defense', 'wildcard'][i] ??
      'wildcard') as ScoreBreakdownItem['slot'],
    symbol: `S${i}`,
    isShort: false,
    lastClose: 10_000,
    thisClose: 10_000,
    returnPct: p / 10,
    points: p,
  }));
  return {
    leagueId: 'L',
    userId,
    season: 1,
    week: 1,
    totalPoints: total,
    computedAt: new Date().toISOString(),
    provisional: false,
    breakdown,
  };
}

describe('buildRecap (pure)', () => {
  const mine = score('A', 100, [120, -20]);
  const theirs = score('B', 50, [50]);
  const all = [mine, theirs]; // sorted high → low

  it('reports the weekly placement with biggest mover/blowup', () => {
    const r = buildRecap('A', 1, 1, mine, 1, 2, all);
    expect(r.rank).toBe(1);
    expect(r.fieldSize).toBe(2);
    expect(r.myScore).toBe(100);
    // Mover = top slot (+120), blowup = most-negative (-20).
    expect(r.biggestMover).toMatchObject({ symbol: 'S0', points: 120 });
    expect(r.biggestBlowup).toMatchObject({ symbol: 'S1', points: -20 });
    expect(r.leagueHigh).toEqual({ userId: 'A', totalPoints: 100 });
    expect(r.leagueLow).toEqual({ userId: 'B', totalPoints: 50 });
  });

  it('reports a lower placement for the trailing manager', () => {
    const r = buildRecap('B', 1, 1, theirs, 2, 2, all);
    expect(r.rank).toBe(2);
    expect(r.fieldSize).toBe(2);
    expect(r.myScore).toBe(50);
  });

  it('yields null mover/blowup for a manager who started nothing', () => {
    const empty = score('A', 0, []);
    const r = buildRecap('A', 1, 1, empty, 1, 1, [empty]);
    expect(r.biggestMover).toBeNull();
    expect(r.biggestBlowup).toBeNull();
    expect(r.rank).toBe(1);
  });
});

// --- generateLeagueRecaps (DB) ----------------------------------------------

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_recap_test')
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

const ROSTER: RosterConfig = {
  slots: ['Anchor', 'Growth', 'Defense', 'Wildcard'],
  bench: 1,
};

async function seedUser(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@x.com`],
  );
  return id;
}

async function seedScore(
  leagueId: string,
  userId: string,
  total: number,
  points: number[],
): Promise<void> {
  const breakdown = points.map((p, i) => ({
    slot: ['anchor', 'growth', 'defense', 'wildcard'][i] ?? 'wildcard',
    symbol: `S${i}`,
    isShort: false,
    lastClose: 10_000,
    thisClose: 10_000,
    returnPct: p / 10,
    points: p,
  }));
  await pool.query(
    `INSERT INTO fs_weekly_score
       (league_id, user_id, season, week, total_points, breakdown, season_id)
     VALUES ($1, $2, 1, 1, $3, $4::jsonb,
             (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))`,
    [leagueId, userId, total, JSON.stringify(breakdown)],
  );
}

function stubRedis(): {
  redis: Redis;
  published: { channel: string; type: string }[];
} {
  const published: { channel: string; type: string }[] = [];
  const publish = vi.fn(async (channel: string, payload: string) => {
    published.push({
      channel,
      type: (JSON.parse(payload) as { type: string }).type,
    });
    return 1;
  });
  return { redis: { publish } as unknown as Redis, published };
}

async function activeLeague(): Promise<{
  leagueId: string;
  a: string;
  b: string;
}> {
  const a = await seedUser('A');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 8, 12, $2::jsonb, 'open', 'active') RETURNING id`,
    [a, JSON.stringify(ROSTER)],
  );
  const leagueId = rows[0]!.id;
  const b = await seedUser('B');
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'commissioner', 'A'), ($1, $3, 'manager', 'B')`,
    [leagueId, a, b],
  );
  await pool.query(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, started_at)
     VALUES ($1, 1, 'regular', 12, now())`,
    [leagueId],
  );
  return { leagueId, a, b };
}

async function recapPayload(userId: string): Promise<RecapPayload> {
  const { rows } = await pool.query<{ payload: RecapPayload }>(
    `SELECT payload FROM fs_notification
      WHERE user_id = $1 AND kind = 'recap'`,
    [userId],
  );
  return rows[0]!.payload;
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_notification');
  await pool.query('DELETE FROM fs_weekly_score');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_season');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM app_user');
});

describe('generateLeagueRecaps', () => {
  it('writes a recap per manager with the weekly ranking', async () => {
    const { leagueId, a, b } = await activeLeague();
    await seedScore(leagueId, a, 100, [120, -20]); // mover +120, blowup -20
    await seedScore(leagueId, b, 50, [50]);

    const { redis, published } = stubRedis();
    const count = await generateLeagueRecaps(pool, leagueId, 1, 1, redis);

    expect(count).toBe(2);
    const ra = await recapPayload(a);
    expect(ra.rank).toBe(1);
    expect(ra.fieldSize).toBe(2);
    expect(ra.biggestMover).toMatchObject({ points: 120 });
    expect(ra.biggestBlowup).toMatchObject({ points: -20 });
    expect(ra.leagueHigh).toEqual({ userId: a, totalPoints: 100 });
    expect(ra.leagueLow).toEqual({ userId: b, totalPoints: 50 });

    const rb = await recapPayload(b);
    expect(rb.rank).toBe(2);
    expect(rb.fieldSize).toBe(2);

    // Each manager got a live push, plus the league-level recap.ready signal.
    expect(published.filter((p) => p.type === 'notification')).toHaveLength(2);
    expect(
      published.some(
        (p) => p.channel === RECAP_READY_CHANNEL && p.type === 'recap.ready',
      ),
    ).toBe(true);
  });

  it('is idempotent on a re-score — overwrites in place and re-surfaces as unread', async () => {
    const { leagueId, a, b } = await activeLeague();
    await seedScore(leagueId, a, 100, [120, -20]);
    await seedScore(leagueId, b, 50, [50]);
    await generateLeagueRecaps(pool, leagueId, 1, 1);

    // Manager reads their recap.
    await pool.query(
      `UPDATE fs_notification SET read_at = now()
        WHERE user_id = $1 AND kind = 'recap'`,
      [a],
    );

    // A dispute re-scores: A now trails B, so A drops to rank 2.
    await pool.query(
      `UPDATE fs_weekly_score SET total_points = 30 WHERE user_id = $1`,
      [a],
    );
    await generateLeagueRecaps(pool, leagueId, 1, 1);

    // Still exactly one recap per manager (upsert, not duplicate).
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fs_notification WHERE kind = 'recap'`,
    );
    expect(rows[0]!.n).toBe(2);

    // A's recap was regenerated (now 2nd) and re-surfaced as unread.
    const ra = await recapPayload(a);
    expect(ra.rank).toBe(2);
    const { rows: readRows } = await pool.query<{ read_at: Date | null }>(
      `SELECT read_at FROM fs_notification WHERE user_id = $1 AND kind = 'recap'`,
      [a],
    );
    expect(readRows[0]!.read_at).toBeNull();
  });
});
