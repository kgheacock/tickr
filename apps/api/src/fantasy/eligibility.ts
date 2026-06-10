/**
 * Fantasy Street item 02 — slot eligibility predicate.
 *
 * The single source of truth for "can this stock fill this slot?", consumed by
 * draft auto-pick (FS-03), lineup auto-fill (FS-04), and waivers (FS-07). Reads
 * fs_player_classification written by the classifier (classify.ts).
 *
 * Defense and Wildcard are UNIVERSAL: any tradeable symbol may be shorted into
 * Defense or dropped into Wildcard, so they never depend on classification.
 */
import type { Pool } from 'pg';
import type { PlayerGroup } from '@tickr/shared-types';

/** Roster slot label → classification group. */
export function slotToGroup(slot: string): PlayerGroup | null {
  const g = slot.trim().toLowerCase();
  switch (g) {
    case 'anchor':
    case 'growth':
    case 'momentum':
    case 'value':
    case 'defense':
    case 'wildcard':
      return g;
    default:
      return null;
  }
}

const UNIVERSAL: ReadonlySet<PlayerGroup> = new Set(['defense', 'wildcard']);

/** The classification groups a symbol qualifies for (eligible rows only). */
export async function groupsFor(
  pool: Pool,
  symbol: string,
): Promise<PlayerGroup[]> {
  const { rows } = await pool.query<{ group: PlayerGroup }>(
    `SELECT "group" FROM fs_player_classification
      WHERE symbol = $1 AND eligible
      ORDER BY "group"`,
    [symbol],
  );
  return rows.map((r) => r.group);
}

/** The roster slot labels a symbol may fill (Title-cased group names). */
export async function slotsFor(pool: Pool, symbol: string): Promise<string[]> {
  const groups = new Set(await groupsFor(pool, symbol));
  // Universal slots are always available, even before/without classification.
  for (const u of UNIVERSAL) groups.add(u);
  return [...groups].map((g) => g.charAt(0).toUpperCase() + g.slice(1)).sort();
}

/** Whether `symbol` may fill `slot`. Universal slots are always eligible. */
export async function isEligible(
  pool: Pool,
  symbol: string,
  slot: string,
): Promise<boolean> {
  const group = slotToGroup(slot);
  if (group == null) return false;
  if (UNIVERSAL.has(group)) return true;
  const { rows } = await pool.query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM fs_player_classification
        WHERE symbol = $1 AND "group" = $2 AND eligible
     ) AS ok`,
    [symbol, group],
  );
  return rows[0]?.ok ?? false;
}
