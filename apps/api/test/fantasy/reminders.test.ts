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
  runLineupReminders,
  notifyDraftScheduled,
} from '../../src/fantasy/reminders.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_reminders_test')
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

// Four mandatory slots — a manager with fewer started is "incomplete".
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

async function seedSeason(leagueId: string): Promise<void> {
  await pool.query(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, started_at)
     SELECT id, 1, 'regular', season_length_weeks, now()
       FROM fs_league WHERE id = $1`,
    [leagueId],
  );
}

/** An active league with a commissioner; returns the league id. */
async function activeLeague(status = 'active'): Promise<string> {
  const commissioner = await seedUser('C');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 8, 12, $2::jsonb, 'open', $3) RETURNING id`,
    [commissioner, JSON.stringify(ROSTER), status],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'commissioner', 'T')`,
    [leagueId, commissioner],
  );
  await seedSeason(leagueId);
  return leagueId;
}

async function addManager(
  leagueId: string,
  name: string,
  opts: { bot?: boolean } = {},
): Promise<string> {
  const userId = await seedUser(name);
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'manager', $3)`,
    [leagueId, userId, name],
  );
  if (opts.bot) {
    await pool.query(
      `INSERT INTO fs_bot_member (league_id, user_id) VALUES ($1, $2)`,
      [leagueId, userId],
    );
  }
  return userId;
}

/** Insert a lineup with `started` non-bench slots, optionally locked. */
async function seedLineup(
  leagueId: string,
  userId: string,
  started: number,
  opts: { locked?: boolean } = {},
): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_lineup (league_id, user_id, season, week, locked_at, season_id)
     VALUES ($1, $2, 1, 1, $3,
             (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))
     RETURNING id`,
    [leagueId, userId, opts.locked ? new Date() : null],
  );
  const lineupId = rows[0]!.id;
  const slots = ['anchor', 'growth', 'defense', 'wildcard'];
  for (let i = 0; i < started; i++) {
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)
       ON CONFLICT (symbol) DO NOTHING`,
      [`S${i}`],
    );
    await pool.query(
      `INSERT INTO fs_lineup_slot (lineup_id, slot, slot_index, symbol, is_short)
       VALUES ($1, $2, 0, $3, $4)`,
      [lineupId, slots[i], `S${i}`, slots[i] === 'defense'],
    );
  }
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

async function notificationCount(kind: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM fs_notification WHERE kind = $1`,
    [kind],
  );
  return rows[0]!.n;
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_notification');
  await pool.query('DELETE FROM fs_lineup_slot');
  await pool.query('DELETE FROM fs_lineup');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM fs_bot_member');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_season');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM app_user');
});

describe('lineup reminders', () => {
  it('reminds a manager with no lineup row at all', async () => {
    const leagueId = await activeLeague();
    const m = await addManager(leagueId, 'M');

    const { redis, published } = stubRedis();
    const result = await runLineupReminders(pool, { week: 1 }, redis);

    // The commissioner (no lineup) and the manager both get reminded.
    expect(result.reminders).toBe(2);
    expect(await notificationCount('lineup_reminder')).toBe(2);
    expect(
      published.filter(
        (p) => p.channel === `ws:notify:${m}` && p.type === 'notification',
      ),
    ).toHaveLength(1);
  });

  it('reminds a partial lineup but not a complete one', async () => {
    const leagueId = await activeLeague();
    const partial = await addManager(leagueId, 'Partial');
    const complete = await addManager(leagueId, 'Complete');
    // Commissioner: give a complete lineup too, so only `partial` is incomplete.
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM fs_league_member WHERE role = 'commissioner'`,
    );
    await seedLineup(leagueId, rows[0]!.user_id, 4);
    await seedLineup(leagueId, partial, 2);
    await seedLineup(leagueId, complete, 4);

    const result = await runLineupReminders(pool, { week: 1 });

    expect(result.reminders).toBe(1);
    const { rows: who } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM fs_notification WHERE kind = 'lineup_reminder'`,
    );
    expect(who.map((r) => r.user_id)).toEqual([partial]);
  });

  it('does not remind a locked lineup even when incomplete', async () => {
    const leagueId = await activeLeague();
    const m = await addManager(leagueId, 'Locked');
    // Lock the commissioner + manager with incomplete lineups.
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM fs_league_member`,
    );
    for (const r of rows)
      await seedLineup(leagueId, r.user_id, 1, { locked: true });

    const result = await runLineupReminders(pool, { week: 1 });
    expect(result.reminders).toBe(0);
    expect(await notificationCount('lineup_reminder')).toBe(0);
    expect(m).toBeTruthy();
  });

  it('fires once per window — a re-run writes nothing new', async () => {
    const leagueId = await activeLeague();
    await addManager(leagueId, 'M');

    const first = await runLineupReminders(pool, { week: 1 });
    expect(first.reminders).toBe(2);

    const { redis, published } = stubRedis();
    const second = await runLineupReminders(pool, { week: 1 }, redis);
    expect(second.reminders).toBe(0); // DB dedupe
    expect(await notificationCount('lineup_reminder')).toBe(2);
    // No new rows → no live pushes on the second tick.
    expect(published).toHaveLength(0);
  });

  it('skips bot managers', async () => {
    const leagueId = await activeLeague();
    const human = await addManager(leagueId, 'Human');
    const bot = await addManager(leagueId, 'Bot', { bot: true });

    const result = await runLineupReminders(pool, { week: 1 });

    // Commissioner + human, never the bot.
    expect(result.reminders).toBe(2);
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM fs_notification WHERE kind = 'lineup_reminder'`,
    );
    expect(rows.map((r) => r.user_id)).not.toContain(bot);
    expect(rows.map((r) => r.user_id)).toContain(human);
  });

  it('only touches active leagues, not forming ones', async () => {
    const forming = await activeLeague('forming');
    await addManager(forming, 'M');

    const result = await runLineupReminders(pool, { week: 1 });
    expect(result.reminders).toBe(0);
  });
});

describe('draft reminders', () => {
  it('reminds every human member once when a draft is scheduled', async () => {
    const leagueId = await activeLeague('drafting');
    const human = await addManager(leagueId, 'Human');
    await addManager(leagueId, 'Bot', { bot: true });
    const draftId = randomUUID();

    const { redis, published } = stubRedis();
    const fired = await notifyDraftScheduled(pool, leagueId, draftId, redis);

    // Commissioner + human; the bot is skipped.
    expect(fired).toBe(2);
    expect(await notificationCount('draft_reminder')).toBe(2);
    expect(
      published.filter((p) => p.channel === `ws:notify:${human}`),
    ).toHaveLength(1);

    // A retried schedule (same draft) does not double-notify.
    const again = await notifyDraftScheduled(pool, leagueId, draftId);
    expect(again).toBe(0);
    expect(await notificationCount('draft_reminder')).toBe(2);
  });
});
