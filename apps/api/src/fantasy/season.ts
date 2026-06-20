/**
 * Fantasy Street item 08 — the season lifecycle.
 *
 * fs_season is the first-class row the implicit `season=1` carried by
 * FS-04/05 now hangs off. The game is weekly-ranking-only, so a season is purely
 * a re-draft container with no playoffs or champion:
 *   - ensureSeason   — called on draft.complete: create/activate the season the
 *                      weekly lineups + scores attach to (idempotent).
 *   - startNewSeason — commissioner re-opens the league for a re-draft once the
 *                      current season is archived; increments season_number,
 *                      clears rosters + draft, preserves membership + history.
 *   - read helpers    — list past seasons for the read-only history endpoints.
 *
 * A season archives when its configured weeks elapse (settle.ts closeWeek). The
 * `season SMALLINT` columns keep human-readable numbering; season_id FKs them to
 * the row this creates.
 */
import type { Pool, PoolClient } from 'pg';
import { FantasyError } from './leagues.js';

export interface SeasonRow {
  id: string;
  league_id: string;
  season_number: number;
  status: 'regular' | 'archived';
  regular_weeks: number;
  started_at: Date | null;
  ended_at: Date | null;
}

const SEASON_COLS = `id, league_id, season_number, status, regular_weeks,
        started_at, ended_at`;

/** The season row for (league, number), or null. */
export async function loadSeason(
  db: Pool | PoolClient,
  leagueId: string,
  seasonNumber: number,
): Promise<SeasonRow | null> {
  const { rows } = await db.query<SeasonRow>(
    `SELECT ${SEASON_COLS} FROM fs_season
      WHERE league_id = $1 AND season_number = $2`,
    [leagueId, seasonNumber],
  );
  return rows[0] ?? null;
}

/**
 * The fs_season id for (league, number), or null when no season row exists yet.
 * The season-scoped inserts (schedule, lineup, score) resolve their NOT NULL
 * season_id FK through this.
 */
export async function resolveSeasonId(
  db: Pool | PoolClient,
  leagueId: string,
  seasonNumber: number,
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM fs_season WHERE league_id = $1 AND season_number = $2`,
    [leagueId, seasonNumber],
  );
  return rows[0]?.id ?? null;
}

/**
 * Reject a write against an archived season — past seasons are read-only
 * (FS-08 DoD). A missing season row (legacy/pre-draft) is not blocked. Used by
 * the lineup write path; background jobs already skip archived leagues.
 */
export async function assertSeasonWritable(
  db: Pool | PoolClient,
  leagueId: string,
  seasonNumber: number,
): Promise<void> {
  const { rows } = await db.query<{ status: string }>(
    `SELECT status FROM fs_season WHERE league_id = $1 AND season_number = $2`,
    [leagueId, seasonNumber],
  );
  if (rows[0]?.status === 'archived') {
    throw new FantasyError('CONFLICT', 'Season is archived and read-only');
  }
}

/**
 * Create (or activate) the league's current season — the one the weekly lineups
 * and scores attach to. Called in-process on draft.complete, post-commit.
 * Activates the latest non-archived season (the one startNewSeason opened for a
 * re-draft), or opens season 1 the first time. Idempotent: a re-fired
 * draft.complete just re-stamps started_at. Returns the season row.
 */
export async function ensureSeason(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<SeasonRow> {
  const { rows: lg } = await db.query<{
    season_length_weeks: number;
  }>(`SELECT season_length_weeks FROM fs_league WHERE id = $1`, [leagueId]);
  if (!lg[0]) throw new FantasyError('NOT_FOUND', 'League not found');

  const { rows: latest } = await db.query<SeasonRow>(
    `SELECT ${SEASON_COLS} FROM fs_season
      WHERE league_id = $1 ORDER BY season_number DESC LIMIT 1`,
    [leagueId],
  );
  const top = latest[0];
  if (top && top.status !== 'archived') {
    const { rows } = await db.query<SeasonRow>(
      `UPDATE fs_season SET started_at = COALESCE(started_at, now())
        WHERE id = $1 RETURNING ${SEASON_COLS}`,
      [top.id],
    );
    return rows[0]!;
  }

  const nextNumber = top ? top.season_number + 1 : 1;
  const { rows } = await db.query<SeasonRow>(
    `INSERT INTO fs_season
       (league_id, season_number, status, regular_weeks, started_at)
     VALUES ($1, $2, 'regular', $3, now())
     ON CONFLICT (league_id, season_number)
       DO UPDATE SET started_at = COALESCE(fs_season.started_at, now())
     RETURNING ${SEASON_COLS}`,
    [leagueId, nextNumber, lg[0].season_length_weeks],
  );
  return rows[0]!;
}

/**
 * Commissioner opens the next season for a re-draft. Requires the current
 * season to be archived (its weeks elapsed). Increments season_number, clears
 * the prior roster + draft so the league can re-draft, and returns the league to
 * `forming`. Membership and every prior season's lineups/scores are preserved
 * (they key on the old season number).
 */
export async function startNewSeason(
  pool: Pool,
  leagueId: string,
): Promise<SeasonRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: lg } = await client.query<{
      season_length_weeks: number;
    }>(`SELECT season_length_weeks FROM fs_league WHERE id = $1 FOR UPDATE`, [
      leagueId,
    ]);
    if (!lg[0]) throw new FantasyError('NOT_FOUND', 'League not found');

    const { rows: latest } = await client.query<SeasonRow>(
      `SELECT ${SEASON_COLS} FROM fs_season
        WHERE league_id = $1 ORDER BY season_number DESC LIMIT 1`,
      [leagueId],
    );
    const top = latest[0];
    if (!top || top.status !== 'archived') {
      throw new FantasyError('CONFLICT', 'Current season is not complete yet');
    }

    const nextNumber = top.season_number + 1;
    const { rows: created } = await client.query<SeasonRow>(
      `INSERT INTO fs_season
         (league_id, season_number, status, regular_weeks)
       VALUES ($1, $2, 'regular', $3)
       RETURNING ${SEASON_COLS}`,
      [leagueId, nextNumber, lg[0].season_length_weeks],
    );

    // Reset for the re-draft: drop current ownership and the old draft (its
    // pick log cascades) so scheduleDraft can open a fresh one. Prior-season
    // lineups/scores are left intact — they carry the old number.
    await client.query(`DELETE FROM fs_roster_entry WHERE league_id = $1`, [
      leagueId,
    ]);
    await client.query(`DELETE FROM fs_draft WHERE league_id = $1`, [leagueId]);
    await client.query(`DELETE FROM fs_waiver_order WHERE league_id = $1`, [
      leagueId,
    ]);
    await client.query(
      `UPDATE fs_league SET status = 'forming' WHERE id = $1`,
      [leagueId],
    );

    await client.query('COMMIT');
    return created[0]!;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Every season for a league, newest first. */
export async function listSeasons(
  db: Pool | PoolClient,
  leagueId: string,
): Promise<SeasonRow[]> {
  const { rows } = await db.query<SeasonRow>(
    `SELECT ${SEASON_COLS} FROM fs_season
      WHERE league_id = $1 ORDER BY season_number DESC`,
    [leagueId],
  );
  return rows;
}
