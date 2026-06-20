import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PlayerGroup, RosterConfig } from '@tickr/shared-types';
import {
  scheduleDraft,
  startDraft,
  makePick,
  autoPickOnClock,
  getDraftState,
} from '../../src/fantasy/draft.js';
import { addBots, removeBot, isBotMember } from '../../src/fantasy/bots.js';
import { pickWindowMs } from '../../src/fantasy/draftClock.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_bots_test')
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

// Small roster keeps drafts short: 3 picks per manager, no bench.
const ROSTER: RosterConfig = {
  slots: ['Anchor', 'Defense', 'Wildcard'],
  bench: 0,
};

async function seedUser(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, $2, $3)`,
    [id, name, `${name}@x.com`],
  );
  return id;
}

async function seedSymbol(
  symbol: string,
  groups: PlayerGroup[] = [],
): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
    [symbol],
  );
  const metrics = JSON.stringify({
    ret3mPct: 5,
    ret12mPct: 10,
    sigma: 0.02,
    avgVolume: 1000,
  });
  for (const g of groups) {
    await pool.query(
      `INSERT INTO fs_player_classification (symbol, "group", eligible, metrics)
       VALUES ($1, $2, true, $3::jsonb)`,
      [symbol, g, metrics],
    );
  }
}

/** A forming league with just the commissioner; bots fill the rest. */
async function formingLeague(size: number): Promise<{
  leagueId: string;
  commish: string;
}> {
  const commish = await seedUser('Commish');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy)
     VALUES ('L', $1, $2, 12, $3::jsonb, 'open') RETURNING id`,
    [commish, size, JSON.stringify(ROSTER)],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'commissioner', 'T0')`,
    [leagueId, commish],
  );
  return { leagueId, commish };
}

/** A broad, eligible corpus so any slot can always be auto-filled. */
async function seedCorpus(): Promise<void> {
  const groups: PlayerGroup[] = ['anchor', 'growth', 'momentum', 'value'];
  for (let i = 0; i < 24; i++) {
    await seedSymbol(`SYM${i}`, groups);
  }
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_draft_pick');
  await pool.query('DELETE FROM fs_draft');
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM fs_bot_member');
  await pool.query('DELETE FROM fs_player_classification');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');
});

describe('pickWindowMs', () => {
  it('gives a bot a 0ms window and a human the full timer', () => {
    expect(pickWindowMs(true, 60)).toBe(0);
    expect(pickWindowMs(false, 60)).toBe(60_000);
  });
});

describe('addBots', () => {
  it('fills open slots so a short group can reach full size', async () => {
    const { leagueId, commish } = await formingLeague(4);
    const view = await addBots(pool, leagueId, 3, commish);
    expect(view.members).toHaveLength(4);
    expect(view.openSlots).toBe(0);
    // Three bots flagged, all as managers, none the commissioner.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM fs_bot_member WHERE league_id = $1`,
      [leagueId],
    );
    expect(Number(rows[0]!.n)).toBe(3);
    const bots = view.members.filter((m) => m.role === 'manager');
    expect(bots).toHaveLength(3);
    for (const b of bots) {
      expect(await isBotMember(pool, leagueId, b.userId)).toBe(true);
    }
    expect(await isBotMember(pool, leagueId, commish)).toBe(false);
  });

  it('rejects adding more bots than open slots', async () => {
    const { leagueId, commish } = await formingLeague(4);
    await expect(addBots(pool, leagueId, 5, commish)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Nothing partially added.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM fs_league_member WHERE league_id = $1`,
      [leagueId],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('only the commissioner may add bots', async () => {
    const { leagueId } = await formingLeague(4);
    const intruder = await seedUser('Intruder');
    await expect(addBots(pool, leagueId, 1, intruder)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('refuses once the league is no longer forming', async () => {
    const { leagueId, commish } = await formingLeague(4);
    await pool.query(`UPDATE fs_league SET status = 'active' WHERE id = $1`, [
      leagueId,
    ]);
    await expect(addBots(pool, leagueId, 1, commish)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('removeBot', () => {
  it('frees a slot before the draft and deletes the reserved user', async () => {
    const { leagueId, commish } = await formingLeague(4);
    const view = await addBots(pool, leagueId, 3, commish);
    const bot = view.members.find((m) => m.role === 'manager')!;

    const after = await removeBot(pool, leagueId, bot.userId, commish);
    expect(after.members).toHaveLength(3);
    expect(after.openSlots).toBe(1);
    // Membership, flag, and the reserved app_user are all gone.
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_user WHERE id = $1`,
      [bot.userId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
    expect(await isBotMember(pool, leagueId, bot.userId)).toBe(false);
  });

  it('will not remove a human manager', async () => {
    const { leagueId, commish } = await formingLeague(4);
    const human = await seedUser('Human');
    await pool.query(
      `INSERT INTO fs_league_member (league_id, user_id, role) VALUES ($1, $2, 'manager')`,
      [leagueId, human],
    );
    await expect(
      removeBot(pool, leagueId, human, commish),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('bot drafting', () => {
  it('a bot-filled league drafts to completion with legal rosters', async () => {
    await seedCorpus();
    const { leagueId, commish } = await formingLeague(4);
    await addBots(pool, leagueId, 3, commish);

    await scheduleDraft(pool, leagueId);
    await startDraft(pool, leagueId);

    // Drive the draft like the clock would: the human picks manually, bots
    // auto-pick instantly. Loop until the draft completes.
    let guard = 0;
    for (;;) {
      const state = await getDraftState(pool, leagueId);
      if (!state || state.status !== 'in_progress' || !state.onClockUserId) {
        break;
      }
      if (await isBotMember(pool, leagueId, state.onClockUserId)) {
        const result = await autoPickOnClock(pool, leagueId);
        expect(result).not.toBeNull();
        expect(result!.pick.auto).toBe(true);
      } else {
        // Human commissioner picks the best available unowned symbol.
        const { rows } = await pool.query<{ symbol: string }>(
          `SELECT us.symbol FROM universe_symbol us
            WHERE NOT EXISTS (
              SELECT 1 FROM fs_roster_entry re
               WHERE re.league_id = $1 AND re.symbol = us.symbol)
            ORDER BY us.symbol LIMIT 1`,
          [leagueId],
        );
        await makePick(
          pool,
          leagueId,
          state.onClockUserId,
          rows[0]!.symbol,
          false,
        );
      }
      if (++guard > 100) throw new Error('draft did not converge');
    }

    const final = await getDraftState(pool, leagueId);
    expect(final!.status).toBe('complete');
    // Every manager — human and bot alike — drafted a full roster (3 each).
    const { rows: counts } = await pool.query<{ user_id: string; n: string }>(
      `SELECT user_id, count(*)::text AS n FROM fs_roster_entry
        WHERE league_id = $1 GROUP BY user_id`,
      [leagueId],
    );
    expect(counts).toHaveLength(4);
    for (const c of counts) expect(Number(c.n)).toBe(3);
    // Bot picks are logged as auto; the human's are not — bots are otherwise
    // drafted into the same ownership table as humans.
    const { rows: botPicks } = await pool.query<{ auto: boolean }>(
      `SELECT dp.auto FROM fs_draft_pick dp
        JOIN fs_bot_member b ON b.user_id = dp.user_id
       WHERE b.league_id = $1`,
      [leagueId],
    );
    expect(botPicks.length).toBe(9); // 3 bots × 3 picks
    expect(botPicks.every((p) => p.auto)).toBe(true);
  });
});
