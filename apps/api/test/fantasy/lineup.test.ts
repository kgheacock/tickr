import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PlayerGroup, RosterConfig } from '@tickr/shared-types';
import {
  getLineup,
  setLineup,
  autofillRemaining,
} from '../../src/fantasy/lineup.js';
import {
  lockLineups,
  isFirstTradingDayOfWeek,
} from '../../src/fantasy/lock.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_lineup_test')
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

// Anchor + Growth + Defense (short) + Wildcard, one bench.
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

async function seedSymbol(
  symbol: string,
  groups: PlayerGroup[] = [],
  ret3mPct = 5,
): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol],
  );
  const metrics = JSON.stringify({ ret3mPct, ret12mPct: 10, sigma: 0.02 });
  for (const g of groups) {
    await pool.query(
      `INSERT INTO fs_player_classification (symbol, "group", eligible, metrics)
       VALUES ($1, $2, true, $3::jsonb)`,
      [symbol, g, metrics],
    );
  }
}

/** Create an active league with one member; return ids. */
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
  // FS-08: the season-1 row the lineup's NOT NULL season_id FK resolves to.
  await pool.query(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, playoff_seeds, started_at)
     SELECT id, 1, 'regular', season_length_weeks, LEAST(4, size), now()
       FROM fs_league WHERE id = $1`,
    [leagueId],
  );
  return { leagueId, userId };
}

async function draftEntry(
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

beforeEach(async () => {
  await pool.query('DELETE FROM fs_lineup_slot');
  await pool.query('DELETE FROM fs_lineup');
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM fs_player_classification');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');
});

/** Seed a roster that can fill every mandatory slot of ROSTER. */
async function seedFullRoster(leagueId: string, userId: string): Promise<void> {
  await seedSymbol('ANCH', ['anchor'], 8);
  await seedSymbol('GROW', ['growth'], 6);
  await seedSymbol('WILD', [], 4); // universal long
  await seedSymbol('SHRT', [], -7); // shorted into Defense
  await draftEntry(leagueId, userId, 'ANCH');
  await draftEntry(leagueId, userId, 'GROW');
  await draftEntry(leagueId, userId, 'WILD');
  await draftEntry(leagueId, userId, 'SHRT', true);
}

describe('getLineup', () => {
  it('initializes an empty unlocked lineup for a fresh week', async () => {
    const { leagueId, userId } = await activeLeague();
    const lineup = await getLineup(pool, leagueId, userId, 1);
    expect(lineup.week).toBe(1);
    expect(lineup.season).toBe(1);
    expect(lineup.locked).toBe(false);
    expect(lineup.slots).toEqual([]);
  });
});

describe('setLineup validation', () => {
  it('accepts a fully valid lineup', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    const lineup = await setLineup(pool, leagueId, userId, {
      week: 1,
      slots: [
        { slot: 'anchor', symbol: 'ANCH' },
        { slot: 'growth', symbol: 'GROW' },
        { slot: 'defense', symbol: 'SHRT' },
        { slot: 'wildcard', symbol: 'WILD' },
      ],
    });
    expect(lineup.slots).toHaveLength(4);
    const defense = lineup.slots.find((s) => s.slot === 'defense')!;
    expect(defense.symbol).toBe('SHRT');
    expect(defense.isShort).toBe(true);
  });

  it('rejects an ineligible placement', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbol('GROW', ['growth'], 6);
    await draftEntry(leagueId, userId, 'GROW');
    await expect(
      setLineup(pool, leagueId, userId, {
        week: 1,
        slots: [{ slot: 'anchor', symbol: 'GROW' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('converts a long placed in Defense to a short for the week', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbol('WILD', [], 4);
    await draftEntry(leagueId, userId, 'WILD'); // long roster entry
    const lineup = await setLineup(pool, leagueId, userId, {
      week: 1,
      slots: [{ slot: 'defense', symbol: 'WILD' }],
    });
    const defense = lineup.slots.find((s) => s.slot === 'defense')!;
    expect(defense.symbol).toBe('WILD');
    expect(defense.isShort).toBe(true);
  });

  it('converts a short placed in a long slot to a long for the week', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbol('SHRT', [], -4);
    await draftEntry(leagueId, userId, 'SHRT', true); // short roster entry
    const lineup = await setLineup(pool, leagueId, userId, {
      week: 1,
      slots: [{ slot: 'wildcard', symbol: 'SHRT' }],
    });
    const wild = lineup.slots.find((s) => s.slot === 'wildcard')!;
    expect(wild.symbol).toBe('SHRT');
    expect(wild.isShort).toBe(false);
  });

  it('rejects starting the same symbol twice', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbol('WILD', ['anchor'], 4);
    await draftEntry(leagueId, userId, 'WILD');
    await expect(
      setLineup(pool, leagueId, userId, {
        week: 1,
        slots: [
          { slot: 'anchor', symbol: 'WILD' },
          { slot: 'wildcard', symbol: 'WILD' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a symbol not on the caller roster', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbol('OTHER', ['anchor'], 4);
    await expect(
      setLineup(pool, leagueId, userId, {
        week: 1,
        slots: [{ slot: 'anchor', symbol: 'OTHER' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a slot the roster config does not have', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedSymbol('MOMO', ['momentum'], 4);
    await draftEntry(leagueId, userId, 'MOMO');
    await expect(
      setLineup(pool, leagueId, userId, {
        week: 1,
        slots: [{ slot: 'momentum', symbol: 'MOMO' }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('autofillRemaining', () => {
  it('fills every empty mandatory slot from the roster and flags autoFilled', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    const lineup = await autofillRemaining(pool, leagueId, userId, 1);
    expect(lineup.autoFilled).toBe(true);
    const slots = new Map(lineup.slots.map((s) => [s.slot, s]));
    expect(slots.get('anchor')!.symbol).toBe('ANCH');
    expect(slots.get('growth')!.symbol).toBe('GROW');
    expect(slots.get('defense')!.symbol).toBe('SHRT');
    expect(slots.get('defense')!.isShort).toBe(true);
    expect(slots.get('wildcard')).toBeDefined();
    // Bench is not auto-filled.
    expect(lineup.slots.some((s) => s.slot === 'bench')).toBe(false);
  });

  it('reconciles an orphaned slot (stock no longer owned) and refills it', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    // A stock in the universe but NOT on the roster, parked in the Growth slot —
    // mimics a started stock that was later sold/traded without cleaning up.
    await seedSymbol('GONE', ['growth'], 5);
    await getLineup(pool, leagueId, userId, 1); // creates the empty lineup row
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM fs_lineup WHERE league_id=$1 AND user_id=$2 AND week=1`,
      [leagueId, userId],
    );
    await pool.query(
      `INSERT INTO fs_lineup_slot (lineup_id, slot, slot_index, symbol, is_short)
       VALUES ($1, 'growth', 0, 'GONE', false)`,
      [rows[0]!.id],
    );

    const lineup = await autofillRemaining(pool, leagueId, userId, 1);
    // The orphan is gone and Growth is refilled from an owned stock.
    expect(lineup.slots.some((s) => s.symbol === 'GONE')).toBe(false);
    expect(lineup.slots.find((s) => s.slot === 'growth')!.symbol).toBe('GROW');
  });

  it('preserves a manual placement and only fills the rest', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    // Manually start WILD in anchor's place via wildcard, then fill the rest.
    await setLineup(pool, leagueId, userId, {
      week: 1,
      slots: [{ slot: 'anchor', symbol: 'ANCH' }],
    });
    const lineup = await autofillRemaining(pool, leagueId, userId, 1);
    const anchor = lineup.slots.find((s) => s.slot === 'anchor')!;
    expect(anchor.symbol).toBe('ANCH');
    expect(lineup.slots.filter((s) => s.slot === 'anchor')).toHaveLength(1);
  });
});

describe('lockLineups', () => {
  it('auto-fills, freezes the lineup, and rejects a later edit', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    const now = new Date('2026-06-15T14:30:00Z'); // a Monday

    const result = await lockLineups(pool, { week: 1, now });
    expect(result.locked).toBe(1);
    expect(result.autoFilled).toBe(1);

    const lineup = await getLineup(pool, leagueId, userId, 1);
    expect(lineup.locked).toBe(true);
    expect(lineup.lockedAt).toBe(now.toISOString());
    expect(lineup.autoFilled).toBe(true);
    // No empty mandatory slot.
    expect(lineup.slots.filter((s) => s.slot !== 'bench')).toHaveLength(4);

    // A post-lock edit is rejected.
    await expect(
      setLineup(pool, leagueId, userId, {
        week: 1,
        slots: [{ slot: 'anchor', symbol: 'ANCH' }],
      }),
    ).rejects.toMatchObject({ code: 'LINEUP_LOCKED' });
  });

  it('is idempotent: a second run locks nothing new', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    const now = new Date('2026-06-15T14:30:00Z');
    await lockLineups(pool, { week: 1, now });
    const second = await lockLineups(pool, { week: 1, now });
    expect(second.locked).toBe(0);
    void leagueId;
    void userId;
  });

  it('leaves a manually completed lineup unflagged', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    await setLineup(pool, leagueId, userId, {
      week: 1,
      slots: [
        { slot: 'anchor', symbol: 'ANCH' },
        { slot: 'growth', symbol: 'GROW' },
        { slot: 'defense', symbol: 'SHRT' },
        { slot: 'wildcard', symbol: 'WILD' },
      ],
    });
    await lockLineups(pool, { week: 1, now: new Date('2026-06-15T14:30:00Z') });
    const lineup = await getLineup(pool, leagueId, userId, 1);
    expect(lineup.locked).toBe(true);
    expect(lineup.autoFilled).toBe(false);
  });

  it('only locks active leagues', async () => {
    const { leagueId, userId } = await activeLeague();
    await seedFullRoster(leagueId, userId);
    await pool.query(`UPDATE fs_league SET status = 'forming'`);
    const result = await lockLineups(pool, {
      week: 1,
      now: new Date('2026-06-15T14:30:00Z'),
    });
    expect(result.locked).toBe(0);
  });
});

describe('isFirstTradingDayOfWeek', () => {
  it('is true on a normal Monday open', () => {
    expect(isFirstTradingDayOfWeek(new Date('2026-06-15T14:30:00Z'))).toBe(
      true,
    );
  });

  it('is false on a Tuesday when Monday traded', () => {
    expect(isFirstTradingDayOfWeek(new Date('2026-06-16T14:30:00Z'))).toBe(
      false,
    );
  });

  it('is false on an NYSE holiday', () => {
    // Memorial Day 2026-05-25 (a Monday holiday).
    expect(isFirstTradingDayOfWeek(new Date('2026-05-25T14:30:00Z'))).toBe(
      false,
    );
  });

  it('defers to Tuesday when Monday is a holiday', () => {
    // Memorial Day week: Mon 5/25 is closed, so Tue 5/26 is the first open.
    expect(isFirstTradingDayOfWeek(new Date('2026-05-26T14:30:00Z'))).toBe(
      true,
    );
  });

  it('is false on a weekend', () => {
    expect(isFirstTradingDayOfWeek(new Date('2026-06-13T14:30:00Z'))).toBe(
      false,
    );
  });
});
