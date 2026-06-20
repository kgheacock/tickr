import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { RosterConfig } from '@tickr/shared-types';
import { FantasyError } from '../../src/fantasy/leagues.js';
import {
  updateMidSeasonSettings,
  removeMember,
  renameTeam,
  transferCommissioner,
  rescoreWeek,
  forceAdvance,
  overrideLineup,
  fantasyHealth,
} from '../../src/fantasy/admin.js';
import { listAudit } from '../../src/fantasy/audit.js';
import { loadWeeklyScore } from '../../src/fantasy/score.js';
import { getLineup } from '../../src/fantasy/lineup.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_commish_test')
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

// Regular-session (15:45 ET) close bars: a default-anchor re-score (which lands
// the 16:00 ET close anchor) must value off these. EDT (-4) so 15:45 ET = 19:45Z.
const REG_PRIOR = new Date('2026-06-05T19:45:00Z');
const REG_THIS = new Date('2026-06-12T19:45:00Z');
// A wall clock just after the Friday close, so currentFriday(now) → 2026-06-12.
const NOW_AFTER_CLOSE = new Date('2026-06-12T22:00:00Z');

async function seedUser(name = 'M'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_user (id, display_name, email) VALUES ($1, $2, $3)`,
    [id, name, `${id}@x.com`],
  );
  return id;
}

interface SeedLeagueOpts {
  status?: string;
  size?: number;
  seasonLengthWeeks?: number;
}

/** A league with a commissioner member; returns ids. */
async function seedLeague(
  opts: SeedLeagueOpts = {},
): Promise<{ leagueId: string; commissioner: string }> {
  const status = opts.status ?? 'active';
  const size = opts.size ?? 4;
  const weeks = opts.seasonLengthWeeks ?? 2;
  const commissioner = await seedUser('C');
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_league
       (name, commissioner_user_id, size, season_length_weeks, roster_config, join_policy, status)
     VALUES ('L', $1, $2, $3, $4::jsonb, 'invite', $5) RETURNING id`,
    [commissioner, size, weeks, JSON.stringify(ROSTER), status],
  );
  const leagueId = rows[0]!.id;
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, 'commissioner', 'Comm Team')`,
    [leagueId, commissioner],
  );
  return { leagueId, commissioner };
}

async function addMember(
  leagueId: string,
  role: 'manager' | 'commissioner' = 'manager',
  name = 'U',
): Promise<string> {
  const userId = await seedUser(name);
  await pool.query(
    `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
     VALUES ($1, $2, $3, $4)`,
    [leagueId, userId, role, `${name} Team`],
  );
  return userId;
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
    [symbol, REG_PRIOR, priorClose, REG_THIS, thisClose],
  );
}

async function rosterEntry(
  leagueId: string,
  userId: string,
  symbol: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO fs_roster_entry (league_id, user_id, symbol, is_short, acquired_via)
     VALUES ($1, $2, $3, false, 'draft')`,
    [leagueId, userId, symbol],
  );
}

/** A locked week-1 lineup with a single started Wildcard (universal slot). */
async function seedWildcardLineup(
  leagueId: string,
  userId: string,
  symbol: string,
): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO fs_lineup (league_id, user_id, season, week, locked_at, season_id)
     VALUES ($1, $2, 1, 1, now(),
             (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))
     RETURNING id`,
    [leagueId, userId],
  );
  await pool.query(
    `INSERT INTO fs_lineup_slot (lineup_id, slot, slot_index, symbol, is_short)
     VALUES ($1, 'wildcard', 0, $2, false)`,
    [rows[0]!.id, symbol],
  );
}

beforeEach(async () => {
  await pool.query(
    `TRUNCATE fs_audit_log, fs_weekly_score,
              fs_lineup_slot, fs_lineup, fs_roster_entry, fs_bot_member,
              fs_draft, fs_season, fs_league_member, fs_league,
              price_bar, universe_symbol, app_user RESTART IDENTITY CASCADE`,
  );
});

// --- DoD 1: mid-season settings ---------------------------------------------

describe('mid-season settings', () => {
  it('edits a mid-season-safe setting (name) on an active league and audits it', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'active' });
    const view = await updateMidSeasonSettings(
      pool,
      leagueId,
      { name: 'Renamed' },
      commissioner,
    );
    expect(view.name).toBe('Renamed');
    const audit = await listAudit(pool, leagueId);
    expect(audit[0]?.action).toBe('settings.update');
    expect(audit[0]?.detail).toMatchObject({ changed: ['name'] });
  });

  it('rejects a structural edit (size) once the draft has started', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'active' });
    await expect(
      updateMidSeasonSettings(pool, leagueId, { size: 6 }, commissioner),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // …and writes no audit row for the rejected change.
    expect(await listAudit(pool, leagueId)).toHaveLength(0);
  });

  it('allows a structural edit while still forming', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'forming' });
    const view = await updateMidSeasonSettings(
      pool,
      leagueId,
      { size: 6 },
      commissioner,
    );
    expect(view.size).toBe(6);
  });

  it('rejects a non-commissioner', async () => {
    const { leagueId } = await seedLeague({ status: 'active' });
    const stranger = await seedUser('S');
    await expect(
      updateMidSeasonSettings(pool, leagueId, { name: 'X' }, stranger),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// --- DoD 2: member management -----------------------------------------------

describe('member management', () => {
  it('removes a pre-draft member and audits it', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'forming' });
    const member = await addMember(leagueId);
    const view = await removeMember(pool, leagueId, member, commissioner);
    expect(view.members.map((m) => m.userId)).not.toContain(member);
    const audit = await listAudit(pool, leagueId);
    expect(audit[0]?.action).toBe('member.remove');
  });

  it('refuses to remove a member after the draft has started', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'active' });
    const member = await addMember(leagueId);
    await expect(
      removeMember(pool, leagueId, member, commissioner),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses to remove the commissioner', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'forming' });
    await expect(
      removeMember(pool, leagueId, commissioner, commissioner),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('renames a member team', async () => {
    const { leagueId, commissioner } = await seedLeague();
    const member = await addMember(leagueId);
    const view = await renameTeam(
      pool,
      leagueId,
      member,
      'Sharks',
      commissioner,
    );
    expect(view.members.find((m) => m.userId === member)?.teamName).toBe(
      'Sharks',
    );
  });

  it('lets a manager rename their own team', async () => {
    const { leagueId } = await seedLeague();
    const member = await addMember(leagueId);
    const view = await renameTeam(pool, leagueId, member, 'Otters', member);
    expect(view.members.find((m) => m.userId === member)?.teamName).toBe(
      'Otters',
    );
  });

  it('forbids a manager from renaming another team', async () => {
    const { leagueId } = await seedLeague();
    const a = await addMember(leagueId);
    const b = await addMember(leagueId);
    await expect(
      renameTeam(pool, leagueId, b, 'Hijacked', a),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('transfers the commissioner role and flips authority', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'active' });
    const heir = await addMember(leagueId);
    await transferCommissioner(pool, leagueId, heir, commissioner);

    // The heir is now the commissioner; the old one is demoted.
    const { rows } = await pool.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM fs_league_member WHERE league_id = $1`,
      [leagueId],
    );
    const roleOf = (u: string) => rows.find((r) => r.user_id === u)?.role;
    expect(roleOf(heir)).toBe('commissioner');
    expect(roleOf(commissioner)).toBe('manager');

    // The old commissioner can no longer act; the new one can.
    await expect(
      updateMidSeasonSettings(pool, leagueId, { name: 'X' }, commissioner),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      updateMidSeasonSettings(pool, leagueId, { name: 'Y' }, heir),
    ).resolves.toMatchObject({ name: 'Y' });
  });

  it('rejects a transfer to a non-member', async () => {
    const { leagueId, commissioner } = await seedLeague();
    const stranger = await seedUser('S');
    await expect(
      transferCommissioner(pool, leagueId, stranger, commissioner),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses to hand the role to a bot', async () => {
    const { leagueId, commissioner } = await seedLeague();
    const bot = await addMember(leagueId, 'manager', 'bot');
    await pool.query(
      `INSERT INTO fs_bot_member (league_id, user_id) VALUES ($1, $2)`,
      [leagueId, bot],
    );
    await expect(
      transferCommissioner(pool, leagueId, bot, commissioner),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

// --- DoD 3: dispute re-score ------------------------------------------------

/** A 2-manager active league with week-1 lineups and price bars. */
async function seedScoredLeague(): Promise<{
  leagueId: string;
  commissioner: string;
  manager: string;
}> {
  const { leagueId, commissioner } = await seedLeague({
    status: 'active',
    seasonLengthWeeks: 2,
  });
  const manager = await addMember(leagueId);
  await seedSeason(leagueId);
  await seedSymbolBars('AAA', 10_000, 11_000); // +10% → +10
  await seedSymbolBars('BBB', 10_000, 10_500); // +5%  → +5
  await rosterEntry(leagueId, commissioner, 'AAA');
  await rosterEntry(leagueId, manager, 'BBB');
  await seedWildcardLineup(leagueId, commissioner, 'AAA');
  await seedWildcardLineup(leagueId, manager, 'BBB');
  return { leagueId, commissioner, manager };
}

describe('dispute re-score', () => {
  it('re-runs scoring, leaves the season open mid-run, and records the reason', async () => {
    const { leagueId, commissioner, manager } = await seedScoredLeague();

    const result = await rescoreWeek(pool, leagueId, 1, commissioner, {
      now: NOW_AFTER_CLOSE,
      reason: 'data gap corrected',
    });

    // FS-05: scores recomputed and persisted.
    expect(result.scores).toHaveLength(2);
    expect(
      (await loadWeeklyScore(pool, leagueId, commissioner, 1))!.totalPoints,
    ).toBe(10);
    expect(
      (await loadWeeklyScore(pool, leagueId, manager, 1))!.totalPoints,
    ).toBe(5);

    // Week 1 of a 2-week season — not the last week, so nothing archives.
    expect(result.close.archived).toBe(false);

    // Audited with the commissioner and their reason.
    const audit = await listAudit(pool, leagueId);
    expect(audit[0]?.action).toBe('score.rescore');
    expect(audit[0]?.actorUserId).toBe(commissioner);
    expect(audit[0]?.detail).toMatchObject({
      week: 1,
      reason: 'data gap corrected',
    });
  });

  it('is reproducible — re-running yields identical scores and no duplicate rows', async () => {
    const { leagueId, commissioner } = await seedScoredLeague();
    const first = await rescoreWeek(pool, leagueId, 1, commissioner, {
      now: NOW_AFTER_CLOSE,
    });
    const second = await rescoreWeek(pool, leagueId, 1, commissioner, {
      now: NOW_AFTER_CLOSE,
    });

    const totals = (r: typeof first) =>
      r.scores.map((s) => s.totalPoints).sort((a, b) => a - b);
    expect(totals(second)).toEqual(totals(first));

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fs_weekly_score WHERE league_id = $1`,
      [leagueId],
    );
    expect(rows[0]!.n).toBe(2); // one per manager — overwritten, not duplicated
  });

  it('rejects a non-commissioner', async () => {
    const { leagueId, manager } = await seedScoredLeague();
    await expect(
      rescoreWeek(pool, leagueId, 1, manager, { now: NOW_AFTER_CLOSE }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// --- DoD 4: force-advance ---------------------------------------------------

describe('force-advance', () => {
  it('closes a mid-season week without archiving and audits it', async () => {
    const { leagueId, commissioner } = await seedLeague({
      status: 'active',
      seasonLengthWeeks: 2,
    });
    await addMember(leagueId);
    await seedSeason(leagueId);

    const result = await forceAdvance(pool, leagueId, commissioner, {
      week: 1,
      reason: 'feed never settled',
    });
    // Week 1 of a 2-week season — closing it leaves the season open.
    expect(result.close.archived).toBe(false);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM fs_season WHERE league_id = $1`,
      [leagueId],
    );
    expect(rows[0]!.status).toBe('regular');
    const audit = await listAudit(pool, leagueId);
    expect(audit[0]?.action).toBe('season.advance');
  });

  it('archives the season on the final week', async () => {
    const { leagueId, commissioner } = await seedLeague({
      status: 'active',
      seasonLengthWeeks: 1,
    });
    await addMember(leagueId);
    await seedSeason(leagueId);

    const result = await forceAdvance(pool, leagueId, commissioner, {
      week: 1,
    });
    expect(result.close.archived).toBe(true);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM fs_season WHERE league_id = $1`,
      [leagueId],
    );
    expect(rows[0]!.status).toBe('archived');
    const { rows: lg } = await pool.query<{ status: string }>(
      `SELECT status FROM fs_league WHERE id = $1`,
      [leagueId],
    );
    expect(lg[0]!.status).toBe('archived');
  });
});

// --- DoD 5 (step 5): lineup override ----------------------------------------

describe('lineup override', () => {
  it('unlocks a locked lineup', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'active' });
    const manager = await addMember(leagueId);
    await seedSeason(leagueId);
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAA', true)
       ON CONFLICT DO NOTHING`,
    );
    await rosterEntry(leagueId, manager, 'AAA');
    await seedWildcardLineup(leagueId, manager, 'AAA');

    const lineup = await overrideLineup(
      pool,
      leagueId,
      manager,
      { week: 1, unlock: true },
      commissioner,
    );
    expect(lineup.locked).toBe(false);
    const audit = await listAudit(pool, leagueId);
    expect(audit[0]?.action).toBe('lineup.override');
    expect(audit[0]?.detail).toMatchObject({ unlocked: true });
  });

  it('sets a lineup on the manager behalf, bypassing the lock', async () => {
    const { leagueId, commissioner } = await seedLeague({ status: 'active' });
    const manager = await addMember(leagueId);
    await seedSeason(leagueId);
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAA', true)
       ON CONFLICT DO NOTHING`,
    );
    await rosterEntry(leagueId, manager, 'AAA');
    await seedWildcardLineup(leagueId, manager, 'AAA'); // locked, empty-ish

    const lineup = await overrideLineup(
      pool,
      leagueId,
      manager,
      {
        week: 1,
        slots: [{ slot: 'wildcard', symbol: 'AAA' }],
        lock: true,
      },
      commissioner,
    );
    expect(lineup.slots.find((s) => s.slot === 'wildcard')?.symbol).toBe('AAA');
    expect(lineup.locked).toBe(true); // re-stamped after the override set
    const reloaded = await getLineup(pool, leagueId, manager, 1);
    expect(reloaded.slots.some((s) => s.symbol === 'AAA')).toBe(true);
  });

  it('rejects a non-commissioner', async () => {
    const { leagueId } = await seedLeague({ status: 'active' });
    const manager = await addMember(leagueId);
    await expect(
      overrideLineup(
        pool,
        leagueId,
        manager,
        { week: 1, unlock: true },
        manager,
      ),
    ).rejects.toBeInstanceOf(FantasyError);
  });
});

// --- DoD 5 (ops view): FS health --------------------------------------------

describe('fantasy health (admin ops)', () => {
  it('counts leagues by status and the last scoring run per league', async () => {
    await seedLeague({ status: 'forming' });
    await seedLeague({ status: 'active' });
    const scored = await seedScoredLeague();
    await rescoreWeek(pool, scored.leagueId, 1, scored.commissioner, {
      now: NOW_AFTER_CLOSE,
    });

    const health = await fantasyHealth(pool);
    expect(health.leaguesByStatus.forming).toBe(1);
    // The two active leagues (one plain, one scored).
    expect(health.leaguesByStatus.active).toBe(2);
    expect(
      health.lastScoringRunByLeague.some((r) => r.leagueId === scored.leagueId),
    ).toBe(true);
  });

  it('flags a stuck week — locked but unscored, surpassed by a later settled week', async () => {
    const { leagueId, commissioner } = await seedLeague({
      status: 'active',
      seasonLengthWeeks: 3,
    });
    const manager = await addMember(leagueId);
    await seedSeason(leagueId);
    // Week 1: locked lineups, never scored (the gap).
    await pool.query(
      `INSERT INTO universe_symbol (symbol, backfilled) VALUES ('AAA', true)
       ON CONFLICT DO NOTHING`,
    );
    await rosterEntry(leagueId, commissioner, 'AAA');
    await seedWildcardLineup(leagueId, commissioner, 'AAA');
    // Week 2: a settled score that surpasses the stuck week 1.
    await pool.query(
      `INSERT INTO fs_weekly_score
         (league_id, user_id, season, week, total_points, breakdown, computed_at, season_id)
       VALUES ($1, $2, 1, 2, 10, '[]'::jsonb, now(),
               (SELECT id FROM fs_season WHERE league_id = $1 AND season_number = 1))`,
      [leagueId, manager],
    );

    const health = await fantasyHealth(pool);
    expect(
      health.stuckWeeks.some((w) => w.leagueId === leagueId && w.week === 1),
    ).toBe(true);
  });
});
