import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import {
  FantasyError,
  createInvite,
  createLeague,
  getLeagueView,
  getUserLeagues,
  joinLeague,
  listLeagues,
  updateLeague,
} from '../../src/fantasy/leagues.js';

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('timescale/timescaledb-ha:pg16')
    .withDatabase('tickr_test')
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
  await pool.query(`DELETE FROM fs_invite`);
  await pool.query(`DELETE FROM fs_league_member`);
  await pool.query(`DELETE FROM fs_league`);
  await pool.query(`DELETE FROM app_user`);
});

let seq = 0;
async function seedUser(name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO app_user (id, display_name) VALUES (gen_random_uuid(), $1) RETURNING id`,
    [`${name}-${seq++}`],
  );
  return rows[0]!.id;
}

function baseLeague(over: Partial<Parameters<typeof createLeague>[0]> = {}) {
  return {
    name: 'My League',
    size: 6,
    seasonLengthWeeks: 14,
    joinPolicy: 'invite' as const,
    ...over,
  };
}

/** Pull the FantasyError code from a rejected domain call. */
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FantasyError) return err.code;
    throw err;
  }
  throw new Error('expected the call to throw a FantasyError');
}

describe('FS-01 leagues & membership', () => {
  // DoD: create → commissioner member → shows in /me.leagues
  it('creates a league with the creator as commissioner and surfaces it on /me', async () => {
    const owner = await seedUser('owner');
    const view = await createLeague(baseLeague(), owner, pool);

    expect(view.commissionerUserId).toBe(owner);
    expect(view.status).toBe('forming');
    expect(view.members).toHaveLength(1);
    expect(view.members[0]).toMatchObject({
      userId: owner,
      role: 'commissioner',
    });
    expect(view.openSlots).toBe(5);
    // Default roster config seeded from the locked slot layout.
    expect(view.rosterConfig.slots).toContain('Defense');

    const leagues = await getUserLeagues(owner, pool);
    expect(leagues).toEqual([
      {
        leagueId: view.id,
        teamName: null,
        role: 'commissioner',
        status: 'forming',
      },
    ]);
  });

  // FS-14 create flow: a seat list derives capacity, sets the commissioner's
  // team name, mints bot seats, and labels human seats as invites.
  it('creates a league from a seat list (team name, bots, labelled invites)', async () => {
    const owner = await seedUser('owner');
    const view = await createLeague(
      {
        name: 'Seated',
        teamName: 'The Dip Buyers',
        seasonLengthWeeks: 52,
        joinPolicy: 'invite',
        members: [
          { isBot: true },
          { isBot: true },
          { isBot: false, email: 'friend@example.com' },
        ],
      },
      owner,
      pool,
    );

    // size = 1 commissioner + 3 seats. For instant play every seat is filled by
    // an auto-manager up front (commissioner + 3 bots), so the league is full
    // with no open slots — the human seat is bot-held until claim-on-join lands.
    expect(view.size).toBe(4);
    expect(view.members).toHaveLength(4);
    expect(view.openSlots).toBe(0);
    expect(view.members.find((m) => m.userId === owner)?.teamName).toBe(
      'The Dip Buyers',
    );

    // The human seat still records a labelled invite (delivery is stubbed for
    // now) so a future claim-on-join can hand its team to the real manager.
    const { rows } = await pool.query<{ email: string | null }>(
      'SELECT email FROM fs_invite WHERE league_id = $1',
      [view.id],
    );
    expect(rows.map((r) => r.email)).toEqual(['friend@example.com']);
  });

  it('rejects a seat list outside the 4–12 capacity', async () => {
    const owner = await seedUser('owner');
    expect(
      await codeOf(() =>
        createLeague(
          {
            name: 'TooSmall',
            seasonLengthWeeks: 52,
            joinPolicy: 'invite',
            members: [{ isBot: true }],
          },
          owner,
          pool,
        ),
      ),
    ).toBe('VALIDATION');
  });

  it('rejects an invalid invitee email in a seat list', async () => {
    const owner = await seedUser('owner');
    expect(
      await codeOf(() =>
        createLeague(
          {
            name: 'BadEmail',
            seasonLengthWeeks: 52,
            joinPolicy: 'invite',
            members: [
              { isBot: true },
              { isBot: true },
              { isBot: false, email: 'not-an-email' },
            ],
          },
          owner,
          pool,
        ),
      ),
    ).toBe('VALIDATION');
  });

  // DoD: a second user joins via a valid invite and appears in LeagueView
  it('lets a second user join via a valid invite token', async () => {
    const owner = await seedUser('owner');
    const friend = await seedUser('friend');
    const league = await createLeague(baseLeague(), owner, pool);

    const invite = await createInvite(league.id, {}, owner, pool);
    const view = await joinLeague(
      league.id,
      { token: invite.token },
      friend,
      pool,
    );

    expect(view.members.map((m) => m.userId).sort()).toEqual(
      [owner, friend].sort(),
    );
    expect(view.members.find((m) => m.userId === friend)?.role).toBe('manager');
    expect(view.openSlots).toBe(4);
  });

  // DoD: open league joinable without a token + listed under ?open=true;
  //      invite league is not.
  it('joins an open league without a token and lists it under ?open=true only', async () => {
    const owner = await seedUser('owner');
    const friend = await seedUser('friend');
    const openLeague = await createLeague(
      baseLeague({ name: 'Open', joinPolicy: 'open' }),
      owner,
      pool,
    );
    const inviteLeague = await createLeague(
      baseLeague({ name: 'Invite', joinPolicy: 'invite' }),
      owner,
      pool,
    );

    const view = await joinLeague(openLeague.id, {}, friend, pool);
    expect(view.members).toHaveLength(2);

    const open = await listLeagues({ open: true }, friend, pool);
    const ids = open.items.map((l) => l.id);
    expect(ids).toContain(openLeague.id);
    expect(ids).not.toContain(inviteLeague.id);

    // A non-member can view an open league but not an invite-only one.
    await expect(
      getLeagueView(openLeague.id, friend, pool),
    ).resolves.toBeTruthy();
    expect(
      await codeOf(() => getLeagueView(inviteLeague.id, friend, pool)),
    ).toBe('FORBIDDEN');
  });

  it('lists my leagues under ?mine=true', async () => {
    const owner = await seedUser('owner');
    const other = await seedUser('other');
    const mine = await createLeague(
      baseLeague({ joinPolicy: 'open' }),
      owner,
      pool,
    );
    await createLeague(baseLeague({ joinPolicy: 'open' }), other, pool);

    const res = await listLeagues({ mine: true }, owner, pool);
    expect(res.items.map((l) => l.id)).toEqual([mine.id]);
  });

  // DoD: full / already-drafting / bad token rejected with the correct code
  it('rejects joining a full league with 409 CONFLICT', async () => {
    const owner = await seedUser('owner');
    const league = await createLeague(
      baseLeague({ size: 4, joinPolicy: 'open' }),
      owner,
      pool,
    );
    // commissioner + 3 joiners = 4 = full
    for (let i = 0; i < 3; i++) {
      await joinLeague(league.id, {}, await seedUser(`m${i}`), pool);
    }
    const late = await seedUser('late');
    expect(await codeOf(() => joinLeague(league.id, {}, late, pool))).toBe(
      'CONFLICT',
    );
  });

  it('rejects joining once the league has left forming with 409 CONFLICT', async () => {
    const owner = await seedUser('owner');
    const friend = await seedUser('friend');
    const league = await createLeague(
      baseLeague({ joinPolicy: 'open' }),
      owner,
      pool,
    );
    await pool.query(`UPDATE fs_league SET status = 'drafting' WHERE id = $1`, [
      league.id,
    ]);
    expect(await codeOf(() => joinLeague(league.id, {}, friend, pool))).toBe(
      'CONFLICT',
    );
  });

  it('rejects an expired or over-used invite token with 422 INVALID_TOKEN', async () => {
    const owner = await seedUser('owner');
    const [a, b, c, d, e] = await Promise.all([
      seedUser('a'),
      seedUser('b'),
      seedUser('c'),
      seedUser('d'),
      seedUser('e'),
    ]);
    const league = await createLeague(baseLeague(), owner, pool);

    // Expired
    const expired = await createInvite(
      league.id,
      { expiresInHours: 1 },
      owner,
      pool,
    );
    await pool.query(
      `UPDATE fs_invite SET expires_at = now() - interval '1 hour' WHERE token = $1`,
      [expired.token],
    );
    expect(
      await codeOf(() =>
        joinLeague(league.id, { token: expired.token }, a!, pool),
      ),
    ).toBe('INVALID_TOKEN');

    // Over-used: maxUses = 1, first join consumes it
    const once = await createInvite(league.id, { maxUses: 1 }, owner, pool);
    await joinLeague(league.id, { token: once.token }, b!, pool);
    expect(
      await codeOf(() =>
        joinLeague(league.id, { token: once.token }, c!, pool),
      ),
    ).toBe('INVALID_TOKEN');

    // Garbage token
    expect(
      await codeOf(() => joinLeague(league.id, { token: 'nope' }, d!, pool)),
    ).toBe('INVALID_TOKEN');

    // Invite-only league with no token at all
    expect(await codeOf(() => joinLeague(league.id, {}, e!, pool))).toBe(
      'INVALID_TOKEN',
    );
  });

  // DoD: commissioner edits while forming; rejected once it leaves forming
  it('allows commissioner settings edits only while forming', async () => {
    const owner = await seedUser('owner');
    const friend = await seedUser('friend');
    const league = await createLeague(baseLeague(), owner, pool);

    const updated = await updateLeague(
      league.id,
      { name: 'Renamed', seasonLengthWeeks: 17, joinPolicy: 'open' },
      owner,
      pool,
    );
    expect(updated).toMatchObject({
      name: 'Renamed',
      seasonLengthWeeks: 17,
      joinPolicy: 'open',
    });

    // Non-commissioner cannot edit.
    expect(
      await codeOf(() => updateLeague(league.id, { name: 'X' }, friend, pool)),
    ).toBe('FORBIDDEN');

    // Locked once it leaves forming.
    await pool.query(`UPDATE fs_league SET status = 'drafting' WHERE id = $1`, [
      league.id,
    ]);
    expect(
      await codeOf(() => updateLeague(league.id, { name: 'Y' }, owner, pool)),
    ).toBe('CONFLICT');
  });

  // DoD: a user cannot hold two memberships in the same league (DB-enforced)
  it('treats a re-join as an idempotent no-op and DB-blocks a duplicate membership', async () => {
    const owner = await seedUser('owner');
    const friend = await seedUser('friend');
    const league = await createLeague(
      baseLeague({ joinPolicy: 'open' }),
      owner,
      pool,
    );

    await joinLeague(league.id, {}, friend, pool);
    const again = await joinLeague(league.id, {}, friend, pool);
    expect(again.members.filter((m) => m.userId === friend)).toHaveLength(1);

    // The composite primary key is the hard guarantee.
    await expect(
      pool.query(
        `INSERT INTO fs_league_member (league_id, user_id, role) VALUES ($1, $2, 'manager')`,
        [league.id, friend],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});
