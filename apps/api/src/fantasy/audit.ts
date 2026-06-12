/**
 * Fantasy Street item 12 — the commissioner/admin audit trail.
 *
 * Append-only record of every privileged league mutation (mid-season settings,
 * member management, dispute re-scores, force-advance, lineup overrides). The
 * direct mutations write their audit row in the *same* transaction as the change
 * (no action without a record); the pipeline actions (re-score / force-advance,
 * which call settle.ts on their own connection) write theirs after the settle
 * succeeds. Read newest-first for the commissioner panel and ops view.
 *
 * Pure, pool/client-driven (no Redis); see test/fantasy/commissioner.test.ts.
 */
import type { Pool, PoolClient } from 'pg';
import type { AuditEntry } from '@tickr/shared-types';

/** A stable verb for the privileged action being recorded. */
export type AuditAction =
  | 'settings.update'
  | 'member.remove'
  | 'member.rename'
  | 'member.transfer'
  | 'score.rescore'
  | 'season.advance'
  | 'lineup.override';

export interface WriteAuditInput {
  leagueId: string;
  actorUserId: string;
  action: AuditAction;
  /** Action-specific context: changed fields, target week, dispute reason, … */
  detail?: Record<string, unknown>;
}

/**
 * Append one audit row. Takes a Pool or an open PoolClient so a direct mutation
 * can enlist it in its own transaction (audit + change commit together), while a
 * post-settle action can pass the pool.
 */
export async function writeAudit(
  db: Pool | PoolClient,
  input: WriteAuditInput,
): Promise<void> {
  await db.query(
    `INSERT INTO fs_audit_log (league_id, actor_user_id, action, detail)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      input.leagueId,
      input.actorUserId,
      input.action,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

interface AuditRow {
  id: string;
  league_id: string;
  actor_user_id: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: Date;
}

function toEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    leagueId: r.league_id,
    actorUserId: r.actor_user_id,
    action: r.action,
    detail: r.detail,
    createdAt: r.created_at.toISOString(),
  };
}

/** A league's audit trail, newest first (capped). */
export async function listAudit(
  db: Pool | PoolClient,
  leagueId: string,
  limit = 100,
): Promise<AuditEntry[]> {
  const capped = Math.min(Math.max(limit, 1), 500);
  const { rows } = await db.query<AuditRow>(
    `SELECT id, league_id, actor_user_id, action, detail, created_at
       FROM fs_audit_log
      WHERE league_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [leagueId, capped],
  );
  return rows.map(toEntry);
}
