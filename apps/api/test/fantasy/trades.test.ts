import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  proposeTrade,
  respondToTrade,
  listTrades,
} from '../../src/fantasy/trades.js';
import { FantasyError } from '../../src/fantasy/leagues.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_trades_test')
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

async function seedUser(name: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, $2, $3)`,
    [id, name, `${randomUUID()}@x.com`],
  );
  return id;
}

async function seedLeague(): Promise<{
  leagueId: string;
  a: string;
  b: string;
}> {
  const a = await seedUser('A');
  const b = await seedUser('B');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, 4, 12, '{}'::jsonb, 'open', 'active') RETURNING id`,
    [a],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name, joined_at)
     VALUES ($1, $2, 'commissioner', 'TA', now()),
            ($1, $3, 'manager', 'TB', now() + interval '1 second')`,
    [leagueId, a, b],
  );
  // FS-08: the season-1 row the lineup NOT NULL season_id FK resolves to.
  await pool.query(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, started_at)
     SELECT id, 1, 'regular', season_length_weeks, now()
       FROM fs_league WHERE id = $1`,
    [leagueId],
  );
  return { leagueId, a, b };
}

async function own(
  leagueId: string,
  userId: string,
  symbol: string,
  isShort = false,
): Promise<void> {
  await pool.query(
    `INSERT INTO universe_symbol (symbol, backfilled) VALUES ($1, true)
     ON CONFLICT (symbol) DO NOTHING`,
    [symbol],
  );
  await pool.query(
    `INSERT INTO fs_roster_entry (league_id, user_id, symbol, is_short, acquired_via)
     VALUES ($1, $2, $3, $4, 'draft')`,
    [leagueId, userId, symbol, isShort],
  );
}

async function ownerOf(
  leagueId: string,
  symbol: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM fs_roster_entry WHERE league_id = $1 AND symbol = $2`,
    [leagueId, symbol],
  );
  return rows[0]?.user_id ?? null;
}

/** The number of distinct owners for a symbol — must always be exactly 1. */
async function ownerCount(leagueId: string, symbol: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM fs_roster_entry
      WHERE league_id = $1 AND symbol = $2`,
    [leagueId, symbol],
  );
  return rows[0]!.n;
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_trade_item');
  await pool.query('DELETE FROM fs_trade');
  await pool.query('DELETE FROM fs_weekly_score');
  await pool.query('DELETE FROM fs_lineup');
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');
});

describe('proposeTrade', () => {
  it('proposes a swap of owned legs', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'GIVE');
    await own(leagueId, b, 'GET');

    const trade = await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['give'],
      receive: ['get'],
    });
    expect(trade.status).toBe('proposed');
    expect(trade.items).toHaveLength(2);
    expect(trade.items.find((i) => i.symbol === 'GIVE')!.fromUserId).toBe(a);
    expect(trade.items.find((i) => i.symbol === 'GET')!.fromUserId).toBe(b);
  });

  it('rejects a give leg the proposer does not own', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, b, 'NOTMINE');
    await expect(
      proposeTrade(pool, leagueId, a, {
        targetUserId: b,
        give: ['NOTMINE'],
        receive: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a symbol on both sides of the trade', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'DUP');
    await expect(
      proposeTrade(pool, leagueId, a, {
        targetUserId: b,
        give: ['DUP'],
        receive: ['DUP'],
      }),
    ).rejects.toBeInstanceOf(FantasyError);
  });
});

describe('respondToTrade', () => {
  it('accepting swaps ownership atomically and keeps the single-owner invariant', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'X', false);
    await own(leagueId, b, 'Y', true); // Y is a short; it rides the swap as-is

    const trade = await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['X'],
      receive: ['Y'],
    });
    const after = await respondToTrade(pool, leagueId, trade.id, b, 'accept');
    expect(after.status).toBe('accepted');
    expect(after.resolvedAt).not.toBeNull();

    // Ownership flipped, each symbol still owned by exactly one manager.
    expect(await ownerOf(leagueId, 'X')).toBe(b);
    expect(await ownerOf(leagueId, 'Y')).toBe(a);
    expect(await ownerCount(leagueId, 'X')).toBe(1);
    expect(await ownerCount(leagueId, 'Y')).toBe(1);

    // The short sense rides along with the symbol.
    const { rows } = await pool.query<{ is_short: boolean }>(
      `SELECT is_short FROM fs_roster_entry WHERE league_id = $1 AND symbol = 'Y'`,
      [leagueId],
    );
    expect(rows[0]!.is_short).toBe(true);
  });

  it('rejecting and cancelling close the trade without moving the roster', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'X');
    await own(leagueId, b, 'Y');

    const t1 = await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['X'],
      receive: ['Y'],
    });
    const rejected = await respondToTrade(pool, leagueId, t1.id, b, 'reject');
    expect(rejected.status).toBe('rejected');
    expect(await ownerOf(leagueId, 'X')).toBe(a); // unchanged

    const t2 = await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['X'],
      receive: ['Y'],
    });
    const cancelled = await respondToTrade(pool, leagueId, t2.id, a, 'cancel');
    expect(cancelled.status).toBe('cancelled');
    expect(await ownerOf(leagueId, 'Y')).toBe(b); // unchanged
  });

  it('only the target may accept; only the proposer may cancel', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'X');
    await own(leagueId, b, 'Y');
    const trade = await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['X'],
      receive: ['Y'],
    });
    // The proposer cannot accept their own proposal.
    await expect(
      respondToTrade(pool, leagueId, trade.id, a, 'accept'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The target cannot cancel.
    await expect(
      respondToTrade(pool, leagueId, trade.id, b, 'cancel'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects accepting a trade whose leg has since moved (stale)', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'X');
    await own(leagueId, b, 'Y');
    const trade = await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['X'],
      receive: ['Y'],
    });

    // A's give leg leaves their roster before B accepts.
    await pool.query(
      `DELETE FROM fs_roster_entry WHERE league_id = $1 AND symbol = 'X'`,
      [leagueId],
    );
    await expect(
      respondToTrade(pool, leagueId, trade.id, b, 'accept'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The swap did not partially apply: Y is still B's.
    expect(await ownerOf(leagueId, 'Y')).toBe(b);
  });

  it('forbids accepting while a lineup is locked and unsettled', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'X');
    await own(leagueId, b, 'Y');
    const trade = await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['X'],
      receive: ['Y'],
    });

    await pool.query(
      `INSERT INTO fs_lineup (league_id, user_id, season, week, locked_at, season_id)
       VALUES ($1, $2, 1, 1, now(),
               (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))`,
      [leagueId, a],
    );
    await expect(
      respondToTrade(pool, leagueId, trade.id, b, 'accept'),
    ).rejects.toMatchObject({ code: 'LINEUP_LOCKED' });
    expect(await ownerOf(leagueId, 'X')).toBe(a); // not swapped
  });

  it('lists trades as incoming for the target and outgoing for the proposer', async () => {
    const { leagueId, a, b } = await seedLeague();
    await own(leagueId, a, 'X');
    await own(leagueId, b, 'Y');
    await proposeTrade(pool, leagueId, a, {
      targetUserId: b,
      give: ['X'],
      receive: ['Y'],
    });
    const forA = await listTrades(pool, leagueId, a);
    const forB = await listTrades(pool, leagueId, b);
    expect(forA.outgoing).toHaveLength(1);
    expect(forA.incoming).toHaveLength(0);
    expect(forB.incoming).toHaveLength(1);
    expect(forB.outgoing).toHaveLength(0);
  });
});
