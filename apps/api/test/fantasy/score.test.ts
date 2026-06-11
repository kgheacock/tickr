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
import type { RosterConfig } from '@tickr/shared-types';
import {
  computeManagerScore,
  settleLeagueWeek,
  loadLeagueScores,
  loadWeeklyScore,
} from '../../src/fantasy/score.js';
import { runWeeklyScoring } from '../../src/jobs/scoring.js';
import { SCORE_UPDATED_CHANNEL } from '../../src/events/publisher.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_score_test')
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

const PRIOR_FRIDAY = new Date('2026-06-05T20:00:00Z');
const THIS_FRIDAY = new Date('2026-06-12T20:00:00Z');
const WEEK_END = new Date('2026-06-12T21:35:00Z'); // job fires after the close

async function seedUser(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@x.com`],
  );
  return id;
}

async function activeLeague(): Promise<{ leagueId: string; userId: string }> {
  const userId = await seedUser('M');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 4, 12, $2::jsonb, 'open', 'active') RETURNING id`,
    [userId, JSON.stringify(ROSTER)],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'commissioner', 'T')`,
    [leagueId, userId],
  );
  return { leagueId, userId };
}

/** Seed a symbol and its two Friday closes (cents), yielding a known return. */
async function seedSymbolBars(
  symbol: string,
  priorClose: number,
  thisClose: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol],
  );
  await pool.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close)
     VALUES ($1, $2, $3, $3, $3, $3), ($1, $4, $5, $5, $5, $5)`,
    [symbol, PRIOR_FRIDAY, priorClose, THIS_FRIDAY, thisClose],
  );
}

async function rosterEntry(
  leagueId: string,
  userId: string,
  symbol: string,
  isShort = false,
): Promise<void> {
  await pool.query(
    `INSERT INTO fs_roster_entry (league_id, user_id, symbol, is_short, acquired_via)
     VALUES ($1, $2, $3, $4, 'draft')`,
    [leagueId, userId, symbol, isShort],
  );
}

interface SlotSpec {
  slot: string;
  symbol: string;
  isShort?: boolean;
  slotIndex?: number;
}

/** Insert a locked lineup with the given started slots. */
async function seedLineup(
  leagueId: string,
  userId: string,
  slots: SlotSpec[],
): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_lineup (league_id, user_id, season, week, locked_at)
     VALUES ($1, $2, 1, 1, now()) RETURNING id`,
    [leagueId, userId],
  );
  const lineupId = rows[0]!.id;
  for (const s of slots) {
    await pool.query(
      `INSERT INTO fs_lineup_slot (lineup_id, slot, slot_index, symbol, is_short)
       VALUES ($1, $2, $3, $4, $5)`,
      [lineupId, s.slot, s.slotIndex ?? 0, s.symbol, s.isShort ?? false],
    );
  }
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_weekly_score');
  await pool.query('DELETE FROM fs_lineup_slot');
  await pool.query('DELETE FROM fs_lineup');
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM price_bar');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');
});

/** Score one manager whose only started slot is the given Defense short. */
async function defensePoints(
  priorClose: number,
  thisClose: number,
): Promise<number> {
  const { leagueId, userId } = await activeLeague();
  await seedSymbolBars('SHRT', priorClose, thisClose);
  await rosterEntry(leagueId, userId, 'SHRT', true);
  await seedLineup(leagueId, userId, [
    { slot: 'defense', symbol: 'SHRT', isShort: true },
  ]);
  const score = await computeManagerScore(pool, userId, {
    leagueId,
    week: 1,
    weekEnd: WEEK_END,
  });
  return score.totalPoints;
}

describe('scoring — README worked examples', () => {
  it('short TSLA −4% scores +40', async () => {
    expect(await defensePoints(10_000, 9_600)).toBe(40);
  });

  it('short TSLA +4% scores −40', async () => {
    expect(await defensePoints(10_000, 10_400)).toBe(-40);
  });

  it('short a stock that wipes out (−100%) scores +1000, floored', async () => {
    expect(await defensePoints(10_000, 0)).toBe(1000);
  });

  it('short a squeeze (+30%) scores −300 (the pick-six)', async () => {
    expect(await defensePoints(10_000, 13_000)).toBe(-300);
  });

  it('a long slot scores r × 10', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbolBars('ANCH', 10_000, 10_800); // +8%
    await rosterEntry(leagueId, userId, 'ANCH');
    await seedLineup(leagueId, userId, [{ slot: 'anchor', symbol: 'ANCH' }]);
    const score = await computeManagerScore(pool, userId, {
      leagueId,
      week: 1,
      weekEnd: WEEK_END,
    });
    expect(score.totalPoints).toBe(80);
  });
});

describe('weekly total', () => {
  it('is the uncapped sum of started slots with losses included; breakdown sums to total', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbolBars('ANCH', 10_000, 10_800); // +8%  → +80
    await seedSymbolBars('GROW', 10_000, 9_500); //  −5%  → −50 (loss)
    await seedSymbolBars('SHRT', 10_000, 13_000); // +30% short → −300 (uncapped)
    await seedSymbolBars('WILD', 10_000, 11_200); // +12% → +120
    await rosterEntry(leagueId, userId, 'ANCH');
    await rosterEntry(leagueId, userId, 'GROW');
    await rosterEntry(leagueId, userId, 'SHRT', true);
    await rosterEntry(leagueId, userId, 'WILD');
    await seedLineup(leagueId, userId, [
      { slot: 'anchor', symbol: 'ANCH' },
      { slot: 'growth', symbol: 'GROW' },
      { slot: 'defense', symbol: 'SHRT', isShort: true },
      { slot: 'wildcard', symbol: 'WILD' },
    ]);
    const score = await computeManagerScore(pool, userId, {
      leagueId,
      week: 1,
      weekEnd: WEEK_END,
    });
    expect(score.totalPoints).toBe(80 - 50 - 300 + 120); // −150
    const sum = score.breakdown.reduce((a, b) => a + b.points, 0);
    expect(sum).toBeCloseTo(score.totalPoints, 10);
  });

  it('excludes bench slots from the total', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbolBars('ANCH', 10_000, 11_000); // +10% → +100
    await seedSymbolBars('BNCH', 10_000, 20_000); // +100% but benched
    await rosterEntry(leagueId, userId, 'ANCH');
    await rosterEntry(leagueId, userId, 'BNCH');
    await seedLineup(leagueId, userId, [
      { slot: 'anchor', symbol: 'ANCH' },
      { slot: 'bench', symbol: 'BNCH' },
    ]);
    const score = await computeManagerScore(pool, userId, {
      leagueId,
      week: 1,
      weekEnd: WEEK_END,
    });
    expect(score.totalPoints).toBe(100);
    expect(score.breakdown).toHaveLength(1);
  });

  it('credits 0 for a slot whose return cannot be resolved', async () => {
    const { leagueId, userId } = await activeLeague();
    // Symbol exists but has no prior-Friday baseline bar.
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('NEW', true)`,
    );
    await pool.query(
      `INSERT INTO price_bar (symbol, ts, open, high, low, close)
       VALUES ('NEW', $1, 9000, 9000, 9000, 9000)`,
      [THIS_FRIDAY],
    );
    await rosterEntry(leagueId, userId, 'NEW');
    await seedLineup(leagueId, userId, [{ slot: 'anchor', symbol: 'NEW' }]);
    const score = await computeManagerScore(pool, userId, {
      leagueId,
      week: 1,
      weekEnd: WEEK_END,
    });
    expect(score.totalPoints).toBe(0);
    expect(score.breakdown[0]!.returnPct).toBeNull();
  });
});

describe('settle + read path', () => {
  it('persists every active league manager and reads back via the query path', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbolBars('ANCH', 10_000, 10_500); // +5% → +50
    await rosterEntry(leagueId, userId, 'ANCH');
    await seedLineup(leagueId, userId, [{ slot: 'anchor', symbol: 'ANCH' }]);

    const settled = await settleLeagueWeek(pool, {
      leagueId,
      week: 1,
      weekEnd: WEEK_END,
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]!.totalPoints).toBe(50);
    expect(settled[0]!.provisional).toBe(false);

    const all = await loadLeagueScores(pool, leagueId, 1);
    expect(all).toHaveLength(1);
    expect(all[0]!.totalPoints).toBe(50);
    expect(typeof all[0]!.totalPoints).toBe('number');

    const one = await loadWeeklyScore(pool, leagueId, userId, 1);
    expect(one!.totalPoints).toBe(50);
    expect(one!.breakdown[0]!.symbol).toBe('ANCH');
  });

  it('re-scoring a week overwrites cleanly (idempotent upsert)', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbolBars('ANCH', 10_000, 10_500); // +5% → +50
    await rosterEntry(leagueId, userId, 'ANCH');
    await seedLineup(leagueId, userId, [{ slot: 'anchor', symbol: 'ANCH' }]);
    await settleLeagueWeek(pool, { leagueId, week: 1, weekEnd: WEEK_END });

    // Correct the Friday close (e.g. an FS-12 dispute) and re-settle.
    await pool.query(
      `UPDATE price_bar SET close = 11000 WHERE symbol = 'ANCH' AND ts = $1`,
      [THIS_FRIDAY],
    );
    await settleLeagueWeek(pool, { leagueId, week: 1, weekEnd: WEEK_END });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM fs_weekly_score WHERE league_id = $1`,
      [leagueId],
    );
    expect(rows[0]!.n).toBe(1); // overwrote, not duplicated
    const one = await loadWeeklyScore(pool, leagueId, userId, 1);
    expect(one!.totalPoints).toBe(100); // +10% now
  });

  it('returns null for a manager with no settled score', async () => {
    const { leagueId, userId } = await activeLeague();
    expect(await loadWeeklyScore(pool, leagueId, userId, 1)).toBeNull();
  });
});

describe('single-owner invariant (shorts off the board)', () => {
  it('rejects a second manager shorting a ticker another owns', async () => {
    const { leagueId, userId } = await activeLeague();
    const other = await seedUser('N');
    await pool.query(
      `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
       VALUES ($1, $2, 'manager', 'U')`,
      [leagueId, other],
    );
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('TSLA', true)`,
    );
    await rosterEntry(leagueId, userId, 'TSLA'); // owned long
    // Another manager cannot short the same league ticker.
    await expect(
      rosterEntry(leagueId, other, 'TSLA', true),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });
});

/** Channel + message captured from a stub Redis publish. */
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

describe('runWeeklyScoring job', () => {
  it('settles only active leagues and publishes score.updated + matchup.updated', async () => {
    const active = await activeLeague();
    await seedSymbolBars('ANCH', 10_000, 10_500); // +5% → +50
    await rosterEntry(active.leagueId, active.userId, 'ANCH');
    await seedLineup(active.leagueId, active.userId, [
      { slot: 'anchor', symbol: 'ANCH' },
    ]);

    // A forming league with a lineup must not be scored.
    const formingUser = await seedUser('F');
    const { rows: fl } = await pool.query<{ id: string }>(
      `INSERT INTO fs_league
         (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
       VALUES ('F', $1, 4, 12, $2::jsonb, 'open', 'forming') RETURNING id`,
      [formingUser, JSON.stringify(ROSTER)],
    );
    const formingLeague = fl[0]!.id;
    await pool.query(
      `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
       VALUES ($1, $2, 'commissioner', 'T')`,
      [formingLeague, formingUser],
    );
    await rosterEntry(formingLeague, formingUser, 'ANCH'); // (different league: allowed)
    await seedLineup(formingLeague, formingUser, [
      { slot: 'anchor', symbol: 'ANCH' },
    ]);

    const { redis, published } = stubRedis();
    const result = await runWeeklyScoring(
      pool,
      { week: 1, weekEnd: WEEK_END },
      redis,
    );

    expect(result.leagues).toBe(1); // only the active league
    expect(result.scores).toBe(1);
    // The forming league was skipped — no persisted score.
    expect(await loadLeagueScores(pool, formingLeague, 1)).toHaveLength(0);
    expect(
      await loadWeeklyScore(pool, active.leagueId, active.userId, 1),
    ).not.toBeNull();
    // Settle publishes both the domain event and the live matchup.
    expect(
      published.some(
        (p) =>
          p.channel === SCORE_UPDATED_CHANNEL && p.type === 'score.updated',
      ),
    ).toBe(true);
    expect(published.some((p) => p.type === 'matchup.updated')).toBe(true);
  });

  it('provisional mode publishes matchup.updated but not score.updated, and persists nothing', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbolBars('ANCH', 10_000, 10_500); // +5%
    await rosterEntry(leagueId, userId, 'ANCH');
    await seedLineup(leagueId, userId, [{ slot: 'anchor', symbol: 'ANCH' }]);

    const { redis, published } = stubRedis();
    await runWeeklyScoring(
      pool,
      { week: 1, weekEnd: WEEK_END, provisional: true, asOf: WEEK_END },
      redis,
    );

    expect(published.some((p) => p.type === 'matchup.updated')).toBe(true);
    expect(published.some((p) => p.type === 'score.updated')).toBe(false);
    expect(await loadWeeklyScore(pool, leagueId, userId, 1)).toBeNull();
  });
});
