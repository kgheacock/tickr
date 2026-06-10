import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { PlayerGroup, RosterConfig } from '@tickr/shared-types';
import {
  computeSnakeOrder,
  totalRoundsOf,
  scheduleDraft,
  startDraft,
  makePick,
  autoPickOnClock,
  getDraftState,
} from '../../src/fantasy/draft.js';
import { FantasyError } from '../../src/fantasy/leagues.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_draft_test')
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

/** A full, forming league with `size` members in deterministic join order. */
async function fullLeague(size: number): Promise<{
  leagueId: string;
  memberIds: string[];
}> {
  const commish = await seedUser('Commish');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy)
     VALUES ('L', $1, $2, 12, $3::jsonb, 'open') RETURNING id`,
    [commish, size, JSON.stringify(ROSTER)],
  );
  const leagueId = rows[0]!.id;
  const memberIds: string[] = [commish];
  // joined_at drives draft order; space them so ASC ordering is unambiguous.
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name, joined_at)
     VALUES ($1, $2, 'commissioner', 'T0', now())`,
    [leagueId, commish],
  );
  for (let i = 1; i < size; i++) {
    const uid = await seedUser(`M${i}`);
    memberIds.push(uid);
    await pool.query(
      `INSERT INTO fs_league_member (league_id, user_id, role, team_name, joined_at)
       VALUES ($1, $2, 'manager', $3, now() + ($4 || ' seconds')::interval)`,
      [leagueId, uid, `T${i}`, String(i)],
    );
  }
  return { leagueId, memberIds };
}

beforeEach(async () => {
  await pool.query('DELETE FROM fs_draft_pick');
  await pool.query('DELETE FROM fs_draft');
  await pool.query('DELETE FROM fs_roster_entry');
  await pool.query('DELETE FROM fs_player_classification');
  await pool.query('DELETE FROM fs_league_member');
  await pool.query('DELETE FROM fs_league');
  await pool.query('DELETE FROM universe_symbol');
  await pool.query('DELETE FROM app_user');
});

describe('computeSnakeOrder', () => {
  it('reverses each successive round', () => {
    expect(computeSnakeOrder(['a', 'b', 'c'], 2)).toEqual([
      'a',
      'b',
      'c',
      'c',
      'b',
      'a',
    ]);
    expect(computeSnakeOrder(['a', 'b'], 3)).toEqual([
      'a',
      'b',
      'b',
      'a',
      'a',
      'b',
    ]);
    expect(totalRoundsOf(ROSTER)).toBe(3);
  });
});

describe('schedule + start', () => {
  it('schedules only a full, forming league and starts the clock at pick 1', async () => {
    const { leagueId, memberIds } = await fullLeague(4);
    const scheduled = await scheduleDraft(pool, leagueId);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.totalPicks).toBe(12); // 4 managers × 3 rounds
    // League flipped to drafting.
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM fs_league WHERE id = $1`,
      [leagueId],
    );
    expect(rows[0]!.status).toBe('drafting');

    const started = await startDraft(pool, leagueId);
    expect(started.status).toBe('in_progress');
    expect(started.currentOverallPick).toBe(1);
    expect(started.onClockUserId).toBe(memberIds[0]);
  });

  it('rejects a second draft for the same league', async () => {
    const { leagueId } = await fullLeague(4);
    await scheduleDraft(pool, leagueId);
    await expect(scheduleDraft(pool, leagueId)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('makePick', () => {
  it('enforces the on-the-clock manager and writes both tables', async () => {
    const { leagueId, memberIds } = await fullLeague(4);
    await seedSymbol('ANCH', ['anchor']);
    await scheduleDraft(pool, leagueId);
    await startDraft(pool, leagueId);

    // Not your turn: member[1] cannot pick at overall pick 1.
    await expect(
      makePick(pool, leagueId, memberIds[1]!, 'ANCH', false),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const result = await makePick(pool, leagueId, memberIds[0]!, 'anch', false);
    expect(result.pick.overallPick).toBe(1);
    expect(result.pick.symbol).toBe('ANCH');
    expect(result.completed).toBe(false);
    expect(result.state.currentOverallPick).toBe(2);
    expect(result.state.onClockUserId).toBe(memberIds[1]);

    // Both the pick log and the ownership table got the row.
    const owned = await pool.query(
      `SELECT user_id, is_short FROM fs_roster_entry WHERE league_id = $1 AND symbol = 'ANCH'`,
      [leagueId],
    );
    expect(owned.rows[0]).toMatchObject({ user_id: memberIds[0] });
  });

  it('blocks a second manager from drafting an owned symbol (409), long or short', async () => {
    const { leagueId, memberIds } = await fullLeague(4);
    await seedSymbol('AAA', ['anchor']);
    await seedSymbol('BBB', ['anchor']);
    await scheduleDraft(pool, leagueId);
    await startDraft(pool, leagueId);

    await makePick(pool, leagueId, memberIds[0]!, 'AAA', false); // pick 1
    // pick 2 is member[1]; try to grab AAA as a short — single-owner invariant.
    await expect(
      makePick(pool, leagueId, memberIds[1]!, 'AAA', true),
    ).rejects.toMatchObject({ code: 'ALREADY_OWNED' });

    // A different symbol succeeds.
    const ok = await makePick(pool, leagueId, memberIds[1]!, 'BBB', false);
    expect(ok.pick.overallPick).toBe(2);
  });

  it('rejects an untradeable symbol', async () => {
    const { leagueId, memberIds } = await fullLeague(4);
    await scheduleDraft(pool, leagueId);
    await startDraft(pool, leagueId);
    await expect(
      makePick(pool, leagueId, memberIds[0]!, 'GHOST', false),
    ).rejects.toBeInstanceOf(FantasyError);
  });
});

describe('autoPickOnClock + completion', () => {
  it('auto-picks need-appropriately and never strands a mandatory slot', async () => {
    const { leagueId, memberIds } = await fullLeague(4);
    // One anchor per manager (the scarce mandatory slot) + fillers for the
    // Defense/Wildcard seats: 4 + 8 = 12 symbols for 12 picks.
    for (const s of ['ANC1', 'ANC2', 'ANC3', 'ANC4'])
      await seedSymbol(s, ['anchor']);
    for (let i = 1; i <= 8; i++) await seedSymbol(`FIL${i}`);

    await scheduleDraft(pool, leagueId);
    await startDraft(pool, leagueId);

    // Run the whole draft on auto-pick (simulating every clock expiry).
    let completed = false;
    for (let i = 0; i < 12; i++) {
      const r = await autoPickOnClock(pool, leagueId);
      expect(r).not.toBeNull();
      completed = r!.completed;
    }
    expect(completed).toBe(true);

    // Draft complete, league active.
    const final = await getDraftState(pool, leagueId);
    expect(final!.status).toBe('complete');
    const { rows: lr } = await pool.query<{ status: string }>(
      `SELECT status FROM fs_league WHERE id = $1`,
      [leagueId],
    );
    expect(lr[0]!.status).toBe('active');

    // Each manager got exactly one ANCHOR-eligible pick (no stranded slot) and
    // exactly totalRounds picks overall.
    for (const uid of memberIds) {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM fs_roster_entry
          WHERE league_id = $1 AND user_id = $2`,
        [leagueId, uid],
      );
      expect(Number(rows[0]!.n)).toBe(3);
      // One of their picks is an anchor (the scarce mandatory slot got covered).
      const { rows: anc } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n
           FROM fs_roster_entry re
           JOIN fs_player_classification c
             ON c.symbol = re.symbol AND c."group" = 'anchor' AND c.eligible
          WHERE re.league_id = $1 AND re.user_id = $2`,
        [leagueId, uid],
      );
      expect(Number(anc[0]!.n)).toBeGreaterThanOrEqual(1);
    }
    // Exactly one short (Defense) per manager — Defense slot covered by a short.
    const { rows: shorts } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM fs_roster_entry
        WHERE league_id = $1 AND is_short = true`,
      [leagueId],
    );
    expect(Number(shorts[0]!.n)).toBe(4);
  });

  it('advances the clock to the next seat on an auto-pick', async () => {
    const { leagueId, memberIds } = await fullLeague(4);
    for (const s of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'])
      await seedSymbol(s, ['anchor']);
    await scheduleDraft(pool, leagueId);
    await startDraft(pool, leagueId);

    const r = await autoPickOnClock(pool, leagueId);
    expect(r!.pick.overallPick).toBe(1);
    expect(r!.pick.auto).toBe(true);
    expect(r!.pick.userId).toBe(memberIds[0]);
    expect(r!.state.currentOverallPick).toBe(2);
    expect(r!.state.onClockUserId).toBe(memberIds[1]);
  });

  it('bails when the expected seat already advanced (expiry race)', async () => {
    const { leagueId, memberIds } = await fullLeague(4);
    await seedSymbol('ANCH', ['anchor']);
    await seedSymbol('FILL');
    await scheduleDraft(pool, leagueId);
    await startDraft(pool, leagueId);

    // A manual pick lands for seat 1, advancing the clock to seat 2.
    await makePick(pool, leagueId, memberIds[0]!, 'ANCH', false);

    // A clock that fired for seat 1 must NOT auto-pick for seat 2's manager.
    expect(await autoPickOnClock(pool, leagueId, 1)).toBeNull();
    // Bound to the current seat, it proceeds.
    const r = await autoPickOnClock(pool, leagueId, 2);
    expect(r!.pick.overallPick).toBe(2);
    expect(r!.pick.userId).toBe(memberIds[1]);
  });
});
