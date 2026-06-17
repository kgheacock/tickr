/**
 * Bot (auto-manager) minting — the pure INSERT half of FS-10, factored out so
 * both `addBots` (item 10) and `createLeague` (FS-14 create flow) can mint bots
 * on their own transaction client without an import cycle through leagues.ts.
 *
 * A bot is an ordinary league member: a reserved `app_user` with no identity
 * rows, added as an `fs_league_member` and flagged in `fs_bot_member`. See
 * bots.ts for the full lifecycle rationale (draft clock, lineup auto-fill).
 */
import type { PoolClient } from 'pg';

/**
 * Display-name pool for minted bots, cycled by `nameOffset` so names stay
 * distinct and stable within a league. Purely cosmetic — bots are keyed by id.
 */
export const BOT_NAMES = [
  'CPU — Bull',
  'CPU — Bear',
  'CPU — Quant',
  'CPU — Momentum',
  'CPU — Value',
  'CPU — Contrarian',
  'CPU — Index',
  'CPU — Wildcard',
  'CPU — Algo',
  'CPU — Ticker',
  'CPU — Short',
  'CPU — Hedge',
] as const;

/**
 * Mint `count` auto-managers into `leagueId` on an existing transaction client.
 * Pure INSERTs with no validation/locking — callers own the open-slot and
 * `forming` checks (addBots) or the derived-capacity check (createLeague).
 */
export async function mintBots(
  client: PoolClient,
  leagueId: string,
  count: number,
  nameOffset: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const n = nameOffset + i;
    const displayName = BOT_NAMES[n % BOT_NAMES.length] ?? `CPU — ${n + 1}`;
    const { rows: userRows } = await client.query<{ id: string }>(
      `INSERT INTO app_user (id, display_name, email, role)
       VALUES (gen_random_uuid(), $1, NULL, 'player') RETURNING id`,
      [displayName],
    );
    const userId = userRows[0]!.id;
    await client.query(
      `INSERT INTO fs_league_member (league_id, user_id, role, team_name)
       VALUES ($1, $2, 'manager', $3)`,
      [leagueId, userId, displayName],
    );
    await client.query(
      `INSERT INTO fs_bot_member (league_id, user_id) VALUES ($1, $2)`,
      [leagueId, userId],
    );
  }
}
