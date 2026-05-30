import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { optionalEnv } from '../config.js';

interface AdminEntry {
  provider: 'google' | 'github';
  subject: string;
}

function parseAdminBootstrap(raw: string): AdminEntry[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx === -1)
        throw new Error(`Invalid ADMIN_BOOTSTRAP entry: ${entry}`);
      const provider = entry.slice(0, idx);
      const subject = entry.slice(idx + 1);
      if (provider !== 'google' && provider !== 'github') {
        throw new Error(`Unknown provider in ADMIN_BOOTSTRAP: ${provider}`);
      }
      return { provider, subject };
    });
}

export async function bootstrapAdmins(): Promise<void> {
  const raw = optionalEnv('ADMIN_BOOTSTRAP');
  if (!raw) return;

  const entries = parseAdminBootstrap(raw);
  if (entries.length === 0) return;

  const client = await pool.connect();
  try {
    for (const { provider, subject } of entries) {
      await client.query('BEGIN');

      // Find or create an app_user for this provider:subject
      const existing = await client.query<{ user_id: string }>(
        `SELECT user_id FROM identity WHERE provider = $1 AND provider_subject = $2`,
        [provider, subject],
      );

      let userId: string;
      if (existing.rows.length > 0) {
        userId = existing.rows[0]!.user_id;
        // Ensure role is admin
        await client.query(`UPDATE app_user SET role = 'admin' WHERE id = $1`, [
          userId,
        ]);
      } else {
        userId = randomUUID();
        await client.query(
          `INSERT INTO app_user (id, display_name, email, role)
           VALUES ($1, 'admin', NULL, 'admin')
           ON CONFLICT (id) DO NOTHING`,
          [userId],
        );
        await client.query(
          `INSERT INTO identity (id, user_id, provider, provider_subject, email_at_link)
           VALUES ($1, $2, $3, $4, NULL)
           ON CONFLICT (provider, provider_subject) DO NOTHING`,
          [randomUUID(), userId, provider, subject],
        );
      }

      await client.query('COMMIT');
      console.log(`[bootstrap] admin provisioned: ${provider}:${subject}`);
    }
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
