/**
 * Fantasy Street — weekly close & season archival.
 *
 * The game is weekly-ranking-only: every manager's lineup is scored each week
 * (score.ts persists fs_weekly_score) and managers are ranked within the league
 * by that weekly total (derived on read, never stored). There are no head-to-head
 * matchups, standings, or playoffs to settle.
 *
 * The one season-level action that remains runs here, in-process after a week is
 * scored (the scoring job calls it post-commit under the scoring lock, not via a
 * Redis echo, so it can never be dropped): when a season's configured weeks have
 * elapsed, archive the season + league so the commissioner can re-draft. A season
 * has no champion — it is purely a re-draft container. Idempotent: re-running a
 * week past the edge is a no-op.
 */
import type { Pool, PoolClient } from 'pg';
import { loadSeason } from './season.js';

export interface CloseResult {
  /** True when this close archived the season (its weeks elapsed). */
  archived: boolean;
}

/**
 * Archive the season + league when the just-scored week is the last of the
 * configured season length. No-op while the season is mid-run or already
 * archived. Returns whether this call archived the season.
 */
async function maybeArchiveSeason(
  db: PoolClient,
  leagueId: string,
  season: number,
  week: number,
): Promise<boolean> {
  const seasonRow = await loadSeason(db, leagueId, season);
  if (!seasonRow) return false;
  if (seasonRow.status !== 'regular' || week < seasonRow.regular_weeks) {
    return false;
  }

  const { rowCount } = await db.query(
    `UPDATE fs_season SET status = 'archived', ended_at = now()
      WHERE id = $1 AND status <> 'archived'`,
    [seasonRow.id],
  );
  if (!rowCount) return false;
  await db.query(`UPDATE fs_league SET status = 'archived' WHERE id = $1`, [
    leagueId,
  ]);
  return true;
}

/**
 * Close a league's just-scored week: archive the season when its weeks have
 * elapsed. The weekly scores are already persisted by score.ts; this only drives
 * the season lifecycle. One transaction, idempotent.
 */
export async function closeWeek(
  pool: Pool,
  leagueId: string,
  week: number,
  season = 1,
): Promise<CloseResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const archived = await maybeArchiveSeason(client, leagueId, season, week);
    await client.query('COMMIT');
    return { archived };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
