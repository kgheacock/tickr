import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  ensureSeason,
  startNewSeason,
  listSeasons,
  loadSeason,
  assertSeasonWritable,
} from '../../src/fantasy/season.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_season_test')
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
    `TRUNCATE fs_season, fs_draft, fs_roster_entry, fs_league_member, fs_league,
              universe_symbol RESTART IDENTITY CASCADE`,
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

async function seedLeague(
  status = 'active',
): Promise<{ leagueId: string; commissioner: string; member: string }> {
  const commissioner = await seedUser();
  const member = await seedUser();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 4, 6, '{}'::jsonb, 'open', $2) RETURNING id`,
    [commissioner, status],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'commissioner', 'TA'), ($1, $3, 'manager', 'TB')`,
    [leagueId, commissioner, member],
  );
  return { leagueId, commissioner, member };
}

describe('ensureSeason', () => {
  it('opens season 1 and is idempotent', async () => {
    const { leagueId } = await seedLeague();
    const first = await ensureSeason(pool, leagueId);
    expect(first).toMatchObject({
      season_number: 1,
      status: 'regular',
      regular_weeks: 6,
      playoff_seeds: 4,
    });
    expect(first.started_at).not.toBeNull();

    const again = await ensureSeason(pool, leagueId);
    expect(again.id).toBe(first.id);
    expect(again.started_at).toEqual(first.started_at); // not re-stamped

    expect(await listSeasons(pool, leagueId)).toHaveLength(1);
  });
});

describe('assertSeasonWritable', () => {
  it('blocks writes to an archived season but allows a live one', async () => {
    const { leagueId } = await seedLeague();
    await ensureSeason(pool, leagueId);
    await expect(
      assertSeasonWritable(pool, leagueId, 1),
    ).resolves.toBeUndefined();

    await pool.query(
      `UPDATE fs_season SET status = 'archived' WHERE league_id = $1`,
      [leagueId],
    );
    await expect(assertSeasonWritable(pool, leagueId, 1)).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
  });
});

describe('startNewSeason', () => {
  async function archiveSeason(
    leagueId: string,
    champion: string,
  ): Promise<void> {
    await pool.query(
      `UPDATE fs_season SET status = 'archived', champion_user_id = $2,
              ended_at = now()
        WHERE league_id = $1 AND season_number = 1`,
      [leagueId, champion],
    );
    await pool.query(`UPDATE fs_league SET status = 'archived' WHERE id = $1`, [
      leagueId,
    ]);
  }

  async function ownSymbol(leagueId: string, userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAA', true)
       ON CONFLICT (symbol) DO NOTHING`,
    );
    await pool.query(
      `INSERT INTO fs_roster_entry (league_id, user_id, symbol, acquired_via)
       VALUES ($1, $2, 'AAA', 'draft')`,
      [leagueId, userId],
    );
  }

  it('rejects opening a new season while the current one is live', async () => {
    const { leagueId } = await seedLeague();
    await ensureSeason(pool, leagueId);
    await expect(startNewSeason(pool, leagueId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('increments the number, resets rosters, and preserves membership + history', async () => {
    const { leagueId, commissioner, member } = await seedLeague();
    await ensureSeason(pool, leagueId);
    await ownSymbol(leagueId, commissioner);
    await pool.query(
      `INSERT INTO fs_draft (league_id, status) VALUES ($1, 'complete')`,
      [leagueId],
    );
    await archiveSeason(leagueId, commissioner);

    const next = await startNewSeason(pool, leagueId);
    expect(next.season_number).toBe(2);
    expect(next.status).toBe('regular');
    expect(next.started_at).toBeNull(); // started on the re-draft

    // Roster + draft cleared for the re-draft; league back to forming.
    const roster = await pool.query(
      `SELECT 1 FROM fs_roster_entry WHERE league_id = $1`,
      [leagueId],
    );
    expect(roster.rowCount).toBe(0);
    const draft = await pool.query(
      `SELECT 1 FROM fs_draft WHERE league_id = $1`,
      [leagueId],
    );
    expect(draft.rowCount).toBe(0);
    const league = await pool.query<{ status: string }>(
      `SELECT status FROM fs_league WHERE id = $1`,
      [leagueId],
    );
    expect(league.rows[0]!.status).toBe('forming');

    // Membership and the archived season-1 row both persist (history).
    const members = await pool.query(
      `SELECT user_id FROM fs_league_member WHERE league_id = $1`,
      [leagueId],
    );
    expect(members.rows.map((r) => r.user_id).sort()).toEqual(
      [commissioner, member].sort(),
    );
    const seasons = await listSeasons(pool, leagueId);
    expect(seasons.map((s) => s.season_number)).toEqual([2, 1]);
    const archived = await loadSeason(pool, leagueId, 1);
    expect(archived).toMatchObject({
      status: 'archived',
      champion_user_id: commissioner,
    });

    // ensureSeason on the re-draft activates season 2 (not a third season).
    const activated = await ensureSeason(pool, leagueId);
    expect(activated.season_number).toBe(2);
    expect(activated.started_at).not.toBeNull();
    expect(await listSeasons(pool, leagueId)).toHaveLength(2);
  });
});
