import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PlayerGroup, RosterConfig } from '@tickr/shared-types';
import { chooseAutoPick, uncoveredSlots } from '../../src/fantasy/autodraft.js';

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

async function seed(
  symbol: string,
  groups: PlayerGroup[],
  ret3mPct: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)`,
    [symbol],
  );
  const metrics = JSON.stringify({
    ret3mPct,
    ret12mPct: ret3mPct,
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

// chooseAutoPick reads ownership for a leagueId; with no fs_roster_entry rows for
// this id the roster is empty and every symbol is available — no league/user
// rows are needed.
const LEAGUE = randomUUID();
const USER = randomUUID();

beforeEach(async () => {
  await pool.query('DELETE FROM fs_player_classification');
  await pool.query('DELETE FROM universe_symbol');
});

describe('uncoveredSlots (pure)', () => {
  it('returns mandatory slots no owned symbol can cover', () => {
    const mandatory = ['Anchor', 'Defense', 'Wildcard'];
    expect(uncoveredSlots(mandatory, [])).toEqual(mandatory);
    // One symbol eligible for Anchor + Wildcard covers Anchor (scarcest first).
    const owned = [{ eligible: new Set(['Anchor', 'Wildcard']) }];
    expect(uncoveredSlots(mandatory, owned)).toEqual(['Defense', 'Wildcard']);
  });
});

describe('chooseAutoPick', () => {
  const cfg = (slots: string[]): RosterConfig => ({ slots, bench: 0 });

  it('targets the scarcest uncovered mandatory slot', async () => {
    await seed('ANC', ['anchor'], 5); // only one anchor → scarcest
    await seed('G1', ['growth'], 5);
    await seed('G2', ['growth'], 5);
    await seed('G3', ['growth'], 5);

    const pick = await chooseAutoPick(
      pool,
      LEAGUE,
      USER,
      cfg(['Anchor', 'Growth', 'Defense', 'Wildcard']),
    );
    expect(pick).toMatchObject({
      slot: 'Anchor',
      symbol: 'ANC',
      isShort: false,
    });
  });

  it('shorts the worst performer for the Defense slot', async () => {
    await seed('UP', ['growth'], 30);
    await seed('DOWN', ['growth'], -20);

    const pick = await chooseAutoPick(pool, LEAGUE, USER, cfg(['Defense']));
    // Defense is short-only; the most negative return is the best short.
    expect(pick).toMatchObject({
      slot: 'Defense',
      symbol: 'DOWN',
      isShort: true,
    });
  });

  it('ranks longs by trailing return for a wildcard seat', async () => {
    await seed('LO', ['growth'], 3);
    await seed('HI', ['growth'], 25);

    const pick = await chooseAutoPick(pool, LEAGUE, USER, cfg(['Wildcard']));
    expect(pick).toMatchObject({ symbol: 'HI', isShort: false });
  });

  it('returns null when nothing is draftable', async () => {
    const pick = await chooseAutoPick(pool, LEAGUE, USER, cfg(['Anchor']));
    expect(pick).toBeNull();
  });
});
