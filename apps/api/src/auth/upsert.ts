import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface UpsertResult {
  userId: string;
  isNew: boolean;
}

export async function upsertUserAndIdentity(
  client: pg.PoolClient,
  opts: {
    provider: 'google' | 'github';
    providerSubject: string;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    role?: 'player' | 'admin';
  },
): Promise<UpsertResult> {
  const {
    provider,
    providerSubject,
    email,
    emailVerified,
    displayName,
    role = 'player',
  } = opts;

  // Check if identity already exists → return existing user
  const existing = await client.query<{ user_id: string }>(
    `SELECT user_id FROM identity WHERE provider = $1 AND provider_subject = $2`,
    [provider, providerSubject],
  );

  if (existing.rows.length > 0) {
    const userId = existing.rows[0]!.user_id;
    if (displayName || email) {
      await client.query(
        `UPDATE app_user
            SET display_name = COALESCE($2, display_name),
                email        = COALESCE($3, email)
          WHERE id = $1`,
        [userId, displayName, email],
      );
    }
    return { userId, isNew: false };
  }

  // Account-merge: only when the incoming email is verified (AU1)
  let userId: string | undefined;
  if (email && emailVerified) {
    const merged = await client.query<{ id: string }>(
      `SELECT id FROM app_user WHERE email = $1 LIMIT 1`,
      [email],
    );
    if (merged.rows.length > 0) {
      userId = merged.rows[0]!.id;
    }
  }

  const isNew = !userId;
  if (!userId) {
    userId = randomUUID();
    await client.query(
      `INSERT INTO app_user (id, display_name, email, role)
       VALUES ($1, $2, $3, $4)`,
      [userId, displayName ?? 'User', email, role],
    );
  }

  await client.query(
    `INSERT INTO identity (id, user_id, provider, provider_subject, email_at_link)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), userId, provider, providerSubject, email],
  );

  return { userId, isNew };
}

export async function attachIdentity(
  client: pg.PoolClient,
  opts: {
    userId: string;
    provider: 'google' | 'github';
    providerSubject: string;
    email: string | null;
  },
): Promise<void> {
  const { userId, provider, providerSubject, email } = opts;

  const conflict = await client.query<{ user_id: string }>(
    `SELECT user_id FROM identity WHERE provider = $1 AND provider_subject = $2`,
    [provider, providerSubject],
  );
  if (conflict.rows.length > 0 && conflict.rows[0]!.user_id !== userId) {
    const err = new Error(
      'Provider subject already linked to a different account',
    );
    (err as NodeJS.ErrnoException).code = 'IDENTITY_CONFLICT';
    throw err;
  }
  if (conflict.rows.length > 0) return;

  await client.query(
    `INSERT INTO identity (id, user_id, provider, provider_subject, email_at_link)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), userId, provider, providerSubject, email],
  );
}

export async function ensurePortfolio(
  client: pg.PoolClient,
  userId: string,
): Promise<string> {
  await client.query(
    `INSERT INTO portfolio (id, user_id, algo_id, cash)
     VALUES ($1, $2, NULL, 100000000)
     ON CONFLICT DO NOTHING`,
    [randomUUID(), userId],
  );
  const row = await client.query<{ id: string }>(
    `SELECT id FROM portfolio WHERE user_id = $1 AND algo_id IS NULL`,
    [userId],
  );
  return row.rows[0]!.id;
}
