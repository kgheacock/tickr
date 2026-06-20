/**
 * Fantasy Street item 14 — instant-play auto-draft.
 *
 * When a league is created already full (every non-commissioner seat is a bot),
 * the create route runs the entire snake draft to completion here so the
 * commissioner can start playing immediately instead of stepping through the
 * forming → scheduled → in_progress → pick-by-pick flow.
 *
 * Deliberately simple: it composes the existing, tested draft primitives —
 * scheduleDraft, startDraft, and the best-available autoPickOnClock drain — and
 * then replicates the *durable* completion side-effects the WS pick clock would
 * normally perform (ensureSeason, see draftClock.broadcastPick).
 * It then goes one step further than the WS path and auto-fills every team's
 * week-1 lineup (lineup.ts) — instant play means the commissioner should land on
 * a league where every team already fields a legal starting lineup, rather than
 * waiting for the Monday lock job to populate them. No Redis or timers: nobody is
 * subscribed to a draft that was never announced, so the WS broadcasts are
 * intentionally skipped. The isolation is intentional — a live human draft can
 * later replace this call without touching createLeague or the draft engine.
 *
 * Inventory guard: it auto-drafts only when the tradeable universe holds at
 * least one symbol per pick. Because chooseAutoPick's Wildcard fallback can fill
 * any pick from any unowned tradeable symbol, that bound makes completion
 * guaranteed. A thin/empty corpus (e.g. a dev DB with no universe rows) would
 * otherwise strand the league mid-draft, so in that case it does nothing and the
 * league rests in `forming` exactly as before.
 */
import type { Pool } from 'pg';
import type { RosterConfig } from '@tickr/shared-types';
import {
  scheduleDraft,
  startDraft,
  autoPickOnClock,
  totalRoundsOf,
} from './draft.js';
import { ensureSeason } from './season.js';
import { autofillRemaining } from './lineup.js';

/** Count of right-now tradeable symbols (mirrors FS-02 / validatePickable). */
const TRADEABLE_COUNT_SQL = `
  SELECT count(*)::int AS n
    FROM universe_symbol us
   WHERE us.removed_at IS NULL
     AND us.backfilled = true
     AND us.data_status IS DISTINCT FROM 'incomplete'`;

/** Total picks the draft will make: size managers × (slots + bench) rounds. */
async function totalPicksFor(pool: Pool, leagueId: string): Promise<number> {
  const { rows } = await pool.query<{
    size: number;
    roster_config: RosterConfig;
  }>(`SELECT size, roster_config FROM fs_league WHERE id = $1`, [leagueId]);
  const row = rows[0];
  if (!row) return 0;
  return row.size * totalRoundsOf(row.roster_config);
}

/**
 * Run a full auto-draft for a freshly-created, full league. Returns true when
 * the draft completed (the league is now `active`, with a season + schedule),
 * or false when it was skipped because the universe can't fill every pick (the
 * league is left untouched in `forming`). The caller re-reads league state.
 */
export async function autoDraftFullLeague(
  pool: Pool,
  leagueId: string,
): Promise<boolean> {
  const totalPicks = await totalPicksFor(pool, leagueId);
  if (totalPicks === 0) return false;

  const { rows } = await pool.query<{ n: number }>(TRADEABLE_COUNT_SQL);
  if ((rows[0]?.n ?? 0) < totalPicks) return false; // not enough inventory

  await scheduleDraft(pool, leagueId);
  await startDraft(pool, leagueId);

  // Drain every seat best-available-by-need. The inventory guard above makes a
  // null (corpus-exhausted) return unreachable, but bail safely if it ever is.
  for (;;) {
    const result = await autoPickOnClock(pool, leagueId);
    if (!result) return false;
    if (result.completed) break;
  }

  // The final pick flipped the league to `active`; mirror the durable
  // post-completion work the pick clock does: open the season.
  const season = await ensureSeason(pool, leagueId);

  // Every team was just drafted but starts the season with an empty lineup.
  // Auto-fill week 1 for each so the commissioner lands on a league where every
  // team — their own and the bots' — already fields a legal starting lineup,
  // instead of waiting for the Monday lock to populate them. Filled-not-locked:
  // managers can still edit before lock. Teams are sourced from the roster, the
  // direct expression of "everyone who has stocks to field," independent of how
  // bot membership is modelled.
  await autofillAllLineups(pool, leagueId, season.season_number);
  return true;
}

/**
 * Auto-fill the week-1 starting lineup for every drafted team. Reuses the same
 * roster-only fill the explicit "auto-fill remaining" action and the lock job
 * use (lineup.ts), so each team fields its best-available legal lineup.
 */
async function autofillAllLineups(
  pool: Pool,
  leagueId: string,
  season: number,
): Promise<void> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM fs_roster_entry
      WHERE league_id = $1 ORDER BY user_id`,
    [leagueId],
  );
  for (const { user_id } of rows) {
    await autofillRemaining(pool, leagueId, user_id, 1, season);
  }
}
