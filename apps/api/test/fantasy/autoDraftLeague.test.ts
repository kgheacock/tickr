import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import type { PlayerGroup } from '@tickr/shared-types';
import { createLeague, getLeagueView } from '../../src/fantasy/leagues.js';
import { autoDraftFullLeague } from '../../src/fantasy/autoDraftLeague.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_autodraft_test')
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
  // Children before parents (FK order).
  for (const t of [
    'fs_lineup_slot',
    'fs_lineup',
    'fs_season',
    'fs_draft_pick',
    'fs_draft',
    'fs_roster_entry',
    'fs_bot_member',
    'fs_invite',
    'fs_league_member',
    'fs_league',
    'fs_player_classification',
    'universe_symbol',
    'app_user',
  ]) {
    await pool.query(`DELETE FROM ${t}`);
  }
});

const LONG_GROUPS: PlayerGroup[] = ['anchor', 'growth', 'momentum', 'value'];

/** Seed `n` tradeable symbols, each classified into one cycling long group. */
async function seedUniverse(n: number): Promise<void> {
  const metrics = JSON.stringify({
    ret3mPct: 5,
    ret12mPct: 10,
    sigma: 0.02,
    avgVolume: 1000,
  });
  for (let i = 0; i < n; i++) {
    const symbol = `SYM${i}`;
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
      [symbol],
    );
    await pool.query(
      `INSERT INTO fs_player_classification (symbol, "group", eligible, metrics)
       VALUES ($1, $2, true, $3::jsonb)`,
      [symbol, LONG_GROUPS[i % LONG_GROUPS.length], metrics],
    );
  }
}

async function seedCommissioner(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_user (id, display_name) VALUES (gen_random_uuid(), 'Owner')
     RETURNING id`,
  );
  return rows[0]!.id;
}

/**
 * A full, just-created league with `seatCount` non-commissioner seats. Every
 * seat is filled by an auto-manager up front (FS-14 instant play), so a mix of
 * bot and human ("email") seats is still full and instantly draftable — the
 * human seats are bot-held and additionally recorded as invites.
 */
async function createFullLeague(
  owner: string,
  seats: { isBot: boolean; email?: string }[],
): Promise<string> {
  const view = await createLeague(
    {
      name: 'Instant',
      teamName: 'The Dip Buyers',
      seasonLengthWeeks: 14,
      joinPolicy: 'invite',
      members: seats,
    },
    owner,
    pool,
  );
  // Precondition under test: every seat is filled, so there are no open slots.
  expect(view.members).toHaveLength(seats.length + 1);
  expect(view.openSlots).toBe(0);
  expect(view.status).toBe('forming');
  return view.id;
}

describe('FS-14 instant-play auto-draft', () => {
  it('drafts a full league (bots + a human seat) to an active, scheduled state', async () => {
    // 6 default slots + 2 bench = 8 rounds × 4 managers = 32 picks.
    await seedUniverse(40);
    const owner = await seedCommissioner();
    // A human ("email") seat must not block the draft — it's bot-held for now.
    const leagueId = await createFullLeague(owner, [
      { isBot: true },
      { isBot: true },
      { isBot: false, email: 'friend@example.com' },
    ]);

    const drafted = await autoDraftFullLeague(pool, leagueId);
    expect(drafted).toBe(true);

    // League is now playable.
    const view = await getLeagueView(leagueId, owner, pool);
    expect(view.status).toBe('active');

    // Every seat was drafted — including the human commissioner's (DoD:
    // auto-draft everyone), filling a full 32-pick board with no duplicates.
    const { rows: roster } = await pool.query<{
      total: number;
      owners: number;
    }>(
      `SELECT count(*)::int AS total, count(DISTINCT user_id)::int AS owners
         FROM fs_roster_entry WHERE league_id = $1`,
      [leagueId],
    );
    expect(roster[0]!.total).toBe(32);
    expect(roster[0]!.owners).toBe(4);

    const { rows: commishRoster } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fs_roster_entry
        WHERE league_id = $1 AND user_id = $2`,
      [leagueId, owner],
    );
    expect(commishRoster[0]!.n).toBe(8);

    // The draft completed and the season was opened.
    const { rows: draft } = await pool.query<{ status: string }>(
      `SELECT status FROM fs_draft WHERE league_id = $1`,
      [leagueId],
    );
    expect(draft[0]!.status).toBe('complete');

    const { rows: season } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fs_season WHERE league_id = $1`,
      [leagueId],
    );
    expect(season[0]!.n).toBeGreaterThan(0);

    // Every team — the commissioner's and all three drafted seats — lands with a
    // full, legal week-1 starting lineup (6 mandatory slots), not just a roster.
    const { rows: lineups } = await pool.query<{
      user_id: string;
      filled: number;
    }>(
      `SELECT l.user_id, count(s.*)::int AS filled
         FROM fs_lineup l
         JOIN fs_lineup_slot s ON s.lineup_id = l.id
        WHERE l.league_id = $1 AND l.season = 1 AND l.week = 1
        GROUP BY l.user_id`,
      [leagueId],
    );
    expect(lineups).toHaveLength(4);
    for (const row of lineups) {
      expect(row.filled).toBe(6);
    }
  });

  it('skips the draft and leaves the league forming when the universe is too thin', async () => {
    // Only 5 tradeable symbols — far fewer than the 32 picks needed.
    await seedUniverse(5);
    const owner = await seedCommissioner();
    const leagueId = await createFullLeague(owner, [
      { isBot: true },
      { isBot: true },
      { isBot: true },
    ]);

    const drafted = await autoDraftFullLeague(pool, leagueId);
    expect(drafted).toBe(false);

    // Untouched: no draft started, league still forming, nothing stranded.
    const view = await getLeagueView(leagueId, owner, pool);
    expect(view.status).toBe('forming');
    const { rows: draft } = await pool.query(
      `SELECT 1 FROM fs_draft WHERE league_id = $1`,
      [leagueId],
    );
    expect(draft).toHaveLength(0);
  });
});
