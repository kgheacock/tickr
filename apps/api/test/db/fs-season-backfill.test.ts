/**
 * FS-08 migration 1700000000019 — the season-1 backfill (DoD #5).
 *
 * The season_id NOT NULL FK is added via the §5 nullable→backfill→NOT NULL
 * pattern against rows that predate FS-08. This test runs the migrations in two
 * phases — everything before the fs_season migration, then the rest — with
 * legacy rows seeded in between, proving the backfill creates a season-1 row per
 * league (status mirrored from the league), points every legacy row's season_id
 * at it, and that SET NOT NULL succeeds against real data. The fs_season
 * migration is located by name (not "last file"), so later FS migrations (e.g.
 * fs_bots) that sort after it don't shift the split.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);
// Everything before the fs_season migration is "the schema as it stood before
// FS-08"; locate it by name so migrations added after it don't move the split.
const allMigrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const beforeSeasonCount = allMigrations.findIndex((f) =>
  f.includes('_fs_season'),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;
let databaseUrl: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_backfill_test')
    .withUsername('tickr_test')
    .withPassword('tickr_test')
    .start();
  databaseUrl = container.getConnectionUri();
  pool = new pg.Pool({ connectionString: databaseUrl });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

async function seedUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, 'U', $2)`,
    [id, `${randomUUID()}@x.com`],
  );
  return id;
}

async function seedLegacyLeague(status: string): Promise<string> {
  const user = await seedUser();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 4, 7, '{}'::jsonb, 'open', $2) RETURNING id`,
    [user, status],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role) VALUES ($1, $2, 'commissioner')`,
    [leagueId, user],
  );
  // Pre-FS-08 rows at season 1, written before season_id exists.
  await pool.query(
    `INSERT INTO fs_lineup (league_id, user_id, season, week) VALUES ($1, $2, 1, 1)`,
    [leagueId, user],
  );
  await pool.query(
    `INSERT INTO fs_weekly_score (league_id, user_id, season, week, total_points)
     VALUES ($1, $2, 1, 1, 42)`,
    [leagueId, user],
  );
  await pool.query(
    `INSERT INTO fs_matchup (league_id, season, week, home_user_id)
     VALUES ($1, 1, 1, $2)`,
    [leagueId, user],
  );
  return leagueId;
}

describe('migration 014 season-1 backfill', () => {
  it('creates a season row per league and rekeys every legacy row to it', async () => {
    // Phase 1: every migration before fs_season (so legacy rows can be seeded
    // without season_id).
    await runner({
      databaseUrl,
      dir: migrationsDir,
      direction: 'up',
      count: beforeSeasonCount,
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    const active = await seedLegacyLeague('active');
    const playoffs = await seedLegacyLeague('playoffs');
    const archived = await seedLegacyLeague('archived');

    // Phase 2: apply 014 (backfill + SET NOT NULL must succeed on the rows above).
    await runner({
      databaseUrl,
      dir: migrationsDir,
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    // A season-1 row per league, status mirrored from the league lifecycle.
    const seasons = await pool.query<{
      id: string;
      league_id: string;
      season_number: number;
      status: string;
      regular_weeks: number;
    }>(
      `SELECT id, league_id, season_number, status, regular_weeks FROM fs_season`,
    );
    const byLeague = new Map(seasons.rows.map((s) => [s.league_id, s]));
    expect(seasons.rows).toHaveLength(3);
    expect(byLeague.get(active)).toMatchObject({
      season_number: 1,
      status: 'regular',
      regular_weeks: 7,
    });
    expect(byLeague.get(playoffs)!.status).toBe('playoffs');
    expect(byLeague.get(archived)!.status).toBe('archived');

    // Every legacy row now points at its league's season-1 row, none null.
    for (const table of ['fs_lineup', 'fs_weekly_score', 'fs_matchup']) {
      const { rows } = await pool.query<{
        league_id: string;
        season_id: string;
      }>(`SELECT league_id, season_id FROM ${table}`);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.season_id).toBe(byLeague.get(r.league_id)!.id);
      }
    }
  });
});
