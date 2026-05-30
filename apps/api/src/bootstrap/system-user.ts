import { pool } from '../db/pool.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

export async function seedSystemUser(): Promise<void> {
  await pool.query(
    `INSERT INTO app_user (id, display_name, email, role)
     VALUES ($1, 'system', NULL, 'admin')
     ON CONFLICT (id) DO NOTHING`,
    [SYSTEM_USER_ID],
  );
  console.log('[bootstrap] system user seeded (idempotent)');
}
