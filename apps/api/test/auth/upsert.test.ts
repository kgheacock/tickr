import { beforeAll, afterAll, describe, it, expect, beforeEach } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import {
  upsertUserAndIdentity,
  attachIdentity,
  ensurePortfolio,
} from '../../src/auth/upsert.js';
import { seedSystemUser } from '../../src/bootstrap/system-user.js';
import { bootstrapAdmins } from '../../src/bootstrap/admin.js';
import { closePool } from '../../src/db/pool.js';

pg.types.setTypeParser(20, Number);

const migrationsDir = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

let container: StartedPostgreSqlContainer;
let client: pg.PoolClient;
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
  client = await pool.connect();

  // Point the pool used by bootstrap helpers at this test DB
  process.env['DATABASE_URL'] = connectionString;
}, 120_000);

afterAll(async () => {
  client?.release();
  await pool?.end();
  await closePool();
  await container?.stop();
});

beforeEach(async () => {
  await client.query(`DELETE FROM identity`);
  await client.query(`DELETE FROM portfolio`);
  await client.query(
    `DELETE FROM app_user WHERE id != '00000000-0000-0000-0000-000000000001'`,
  );
});

describe('upsertUserAndIdentity', () => {
  it('creates a new user and identity on first sign-in', async () => {
    const { userId, isNew } = await upsertUserAndIdentity(client, {
      provider: 'google',
      providerSubject: 'g-sub-1',
      email: 'alice@example.com',
      emailVerified: true,
      displayName: 'Alice',
    });
    expect(isNew).toBe(true);

    const row = await client.query<{ display_name: string; role: string }>(
      `SELECT display_name, role FROM app_user WHERE id = $1`,
      [userId],
    );
    expect(row.rows[0]!.display_name).toBe('Alice');
    expect(row.rows[0]!.role).toBe('player');
  });

  it('returns the existing user on second sign-in (same provider+sub)', async () => {
    const { userId: first } = await upsertUserAndIdentity(client, {
      provider: 'github',
      providerSubject: 'gh-42',
      email: 'bob@example.com',
      emailVerified: true,
      displayName: 'Bob',
    });
    const { userId: second, isNew } = await upsertUserAndIdentity(client, {
      provider: 'github',
      providerSubject: 'gh-42',
      email: 'bob@example.com',
      emailVerified: true,
      displayName: 'Bob Updated',
    });
    expect(isNew).toBe(false);
    expect(second).toBe(first);
  });

  it('AU1: auto-links when verified emails match (different providers)', async () => {
    // First: Google sign-in creates the user
    const { userId: googleUserId } = await upsertUserAndIdentity(client, {
      provider: 'google',
      providerSubject: 'g-sub-au1',
      email: 'shared@example.com',
      emailVerified: true,
      displayName: 'SharedUser',
    });

    // Second: GitHub sign-in with the same verified email → must attach to same user
    const { userId: githubUserId, isNew } = await upsertUserAndIdentity(
      client,
      {
        provider: 'github',
        providerSubject: 'gh-au1',
        email: 'shared@example.com',
        emailVerified: true,
        displayName: 'SharedUser',
      },
    );

    expect(isNew).toBe(false);
    expect(githubUserId).toBe(googleUserId);

    const identities = await client.query<{ provider: string }>(
      `SELECT provider FROM identity WHERE user_id = $1 ORDER BY provider`,
      [googleUserId],
    );
    expect(identities.rows.map((r) => r.provider)).toEqual([
      'github',
      'google',
    ]);
  });

  it('AU1: does NOT merge when email is unverified', async () => {
    await upsertUserAndIdentity(client, {
      provider: 'google',
      providerSubject: 'g-sub-nomerge',
      email: 'victim@example.com',
      emailVerified: true,
      displayName: 'Victim',
    });

    const { isNew } = await upsertUserAndIdentity(client, {
      provider: 'github',
      providerSubject: 'gh-attacker',
      email: 'victim@example.com',
      emailVerified: false,
      displayName: 'Attacker',
    });

    expect(isNew).toBe(true); // creates a separate user

    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM app_user WHERE email = 'victim@example.com'`,
    );
    expect(Number(count.rows[0]!.count)).toBe(2);
  });
});

describe('attachIdentity', () => {
  it('rejects 409 when provider subject belongs to a different user', async () => {
    const { userId: _user1 } = await upsertUserAndIdentity(client, {
      provider: 'google',
      providerSubject: 'g-u1',
      email: null,
      emailVerified: false,
      displayName: 'User1',
    });
    const { userId: user2 } = await upsertUserAndIdentity(client, {
      provider: 'github',
      providerSubject: 'gh-u2',
      email: null,
      emailVerified: false,
      displayName: 'User2',
    });

    await expect(
      attachIdentity(client, {
        userId: user2,
        provider: 'google',
        providerSubject: 'g-u1', // already owned by user1
        email: null,
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  });
});

describe('ensurePortfolio', () => {
  it('creates a portfolio on first call and is idempotent', async () => {
    const { userId } = await upsertUserAndIdentity(client, {
      provider: 'google',
      providerSubject: 'g-portfolio',
      email: null,
      emailVerified: false,
      displayName: 'PortUser',
    });

    const id1 = await ensurePortfolio(client, userId);
    const id2 = await ensurePortfolio(client, userId);
    expect(id1).toBe(id2);

    const row = await client.query<{ cash: number }>(
      `SELECT cash FROM portfolio WHERE id = $1`,
      [id1],
    );
    expect(row.rows[0]!.cash).toBe(100_000_000);
  });
});

describe('seedSystemUser', () => {
  it('is idempotent — two boots leave one row', async () => {
    await seedSystemUser();
    await seedSystemUser();

    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM app_user WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(Number(count.rows[0]!.count)).toBe(1);

    const row = await client.query<{ role: string; display_name: string }>(
      `SELECT role, display_name FROM app_user WHERE id = '00000000-0000-0000-0000-000000000001'`,
    );
    expect(row.rows[0]!.role).toBe('admin');
    expect(row.rows[0]!.display_name).toBe('system');
  });
});

describe('bootstrapAdmins', () => {
  it('provisions an admin user from ADMIN_BOOTSTRAP env', async () => {
    process.env['ADMIN_BOOTSTRAP'] = 'github:999888777';
    await bootstrapAdmins();

    const identity = await client.query<{ user_id: string }>(
      `SELECT user_id FROM identity WHERE provider = 'github' AND provider_subject = '999888777'`,
    );
    expect(identity.rows).toHaveLength(1);

    const user = await client.query<{ role: string }>(
      `SELECT role FROM app_user WHERE id = $1`,
      [identity.rows[0]!.user_id],
    );
    expect(user.rows[0]!.role).toBe('admin');
  });

  it('is idempotent — two calls leave one identity row', async () => {
    process.env['ADMIN_BOOTSTRAP'] = 'github:999888777';
    await bootstrapAdmins();
    await bootstrapAdmins();

    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM identity WHERE provider = 'github' AND provider_subject = '999888777'`,
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
  });
});
