/**
 * Fantasy Street item 03 — auto-draft selection (best-available-by-need).
 *
 * Pure, pool-driven: pick the legal stock that fills the on-the-clock manager's
 * most-needed unfilled slot, per FS-02 classification + eligibility. Used on
 * pick-clock expiry (fantasy/draftClock.ts) and reused by FS-10 auto-managers.
 *
 * "Need" is read from the *actual* roster, not a pick counter, so it stays
 * correct when a manager mixes manual and auto picks. The single guarantee it
 * upholds — the DoD bar — is that no mandatory slot is left strandable: scarce
 * mandatory slots are covered before bench/wildcard filler.
 *
 * Two soft defaults the spec leaves open (documented, not stalled on):
 *   - ranking metric is trailing 3-month return (the stored `ret3mPct`); for a
 *     Defense short the *worst* performer is the best pick, so order flips.
 *   - among equal slots, the scarcest (fewest eligible symbols) is filled first.
 */
import type { Pool, PoolClient } from 'pg';
import type { RosterConfig } from '@tickr/shared-types';

type Db = Pool | PoolClient;

/** The two slots any tradeable symbol can fill without classification. */
const UNIVERSAL_SLOTS: ReadonlySet<string> = new Set(['Defense', 'Wildcard']);

/** Reusable "is this symbol tradeable right now?" predicate (mirrors FS-02). */
const TRADEABLE = `
  us.removed_at IS NULL
  AND us.backfilled = true
  AND us.data_status IS DISTINCT FROM 'incomplete'`;

export interface AutoPick {
  symbol: string;
  isShort: boolean;
  /** The slot this pick was chosen to cover; surfaced for logs/telemetry. */
  slot: string;
}

/** Title-case a slot label the way eligibility.ts does ("growth" → "Growth"). */
export function normalizeSlot(slot: string): string {
  const s = slot.trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** The roster slots a symbol already owned can stand in for. */
function eligibleSlotsOf(isShort: boolean, groups: string[]): Set<string> {
  if (isShort) return new Set(['Defense', 'Wildcard']); // Defense is short-only
  const slots = new Set(groups.map((g) => normalizeSlot(g)));
  slots.delete('Defense'); // a long can't occupy the short-only Defense slot
  slots.add('Wildcard'); // any long is wildcard-eligible
  return slots;
}

/**
 * Greedily assign owned symbols to mandatory slots — scarcest slot first, any
 * eligible unused symbol — and return the mandatory slots still uncovered.
 * Greedy (not a full bipartite matching): scarcest-first ordering makes it
 * exact for the common case of single-slot stocks and a safe heuristic
 * otherwise. Input `mandatory` must already be scarcity-ordered.
 */
export function uncoveredSlots(
  mandatory: string[],
  owned: { eligible: Set<string> }[],
): string[] {
  const used = new Array(owned.length).fill(false);
  const covered = new Set<string>();
  for (const slot of mandatory) {
    const i = owned.findIndex((o, idx) => !used[idx] && o.eligible.has(slot));
    if (i >= 0) {
      used[i] = true;
      covered.add(slot);
    }
  }
  return mandatory.filter((s) => !covered.has(s));
}

/** Mandatory slots (config order de-duped) ordered scarcest-first. */
async function scarcityOrderedSlots(
  db: Db,
  cfg: RosterConfig,
): Promise<string[]> {
  const slots = [...new Set(cfg.slots.map((s) => normalizeSlot(s)))];
  const nonUniversal = slots.filter((s) => !UNIVERSAL_SLOTS.has(s));
  const counts = new Map<string, number>();
  if (nonUniversal.length > 0) {
    const { rows } = await db.query<{ group: string; n: number }>(
      `SELECT "group", count(*)::int AS n
         FROM fs_player_classification
        WHERE eligible AND "group" = ANY($1)
        GROUP BY "group"`,
      [nonUniversal.map((s) => s.toLowerCase())],
    );
    for (const r of rows) counts.set(normalizeSlot(r.group), r.n);
  }
  // Universal slots are effectively unbounded → least scarce → sorted last.
  const scarcity = (s: string): number =>
    UNIVERSAL_SLOTS.has(s) ? Number.POSITIVE_INFINITY : (counts.get(s) ?? 0);
  return slots.sort((a, b) => scarcity(a) - scarcity(b));
}

/** The manager's owned symbols with their slot-eligibility sets. */
async function loadOwned(
  db: Db,
  leagueId: string,
  userId: string,
): Promise<{ eligible: Set<string> }[]> {
  const { rows } = await db.query<{
    is_short: boolean;
    groups: string[] | null;
  }>(
    `SELECT re.is_short,
            array_remove(array_agg(c."group") FILTER (WHERE c.eligible), NULL)
              AS groups
       FROM fs_roster_entry re
       LEFT JOIN fs_player_classification c ON c.symbol = re.symbol
      WHERE re.league_id = $1 AND re.user_id = $2
      GROUP BY re.symbol, re.is_short`,
    [leagueId, userId],
  );
  return rows.map((r) => ({
    eligible: eligibleSlotsOf(r.is_short, r.groups ?? []),
  }));
}

/** Best available unowned tradeable symbol eligible for `slot`. */
async function bestAvailableFor(
  db: Db,
  leagueId: string,
  slot: string,
): Promise<string | null> {
  const isShort = slot === 'Defense';
  // Defense short: most negative return is the best short → ascending.
  const dir = isShort ? 'ASC' : 'DESC';
  const params: unknown[] = [leagueId];
  let eligibilityWhere = '';
  if (!UNIVERSAL_SLOTS.has(slot)) {
    params.push(slot.toLowerCase());
    eligibilityWhere = `AND EXISTS (
      SELECT 1 FROM fs_player_classification c
       WHERE c.symbol = us.symbol AND c.eligible AND c."group" = $2)`;
  }
  const { rows } = await db.query<{ symbol: string }>(
    `SELECT us.symbol
       FROM universe_symbol us
       LEFT JOIN (
         SELECT symbol, (metrics->>'ret3mPct')::float AS ret3m
           FROM fs_player_classification
          GROUP BY symbol, metrics
       ) m ON m.symbol = us.symbol
      WHERE ${TRADEABLE}
        AND NOT EXISTS (
          SELECT 1 FROM fs_roster_entry re
           WHERE re.league_id = $1 AND re.symbol = us.symbol)
        ${eligibilityWhere}
      ORDER BY m.ret3m ${dir} NULLS LAST, us.symbol ASC
      LIMIT 1`,
    params,
  );
  return rows[0]?.symbol ?? null;
}

/**
 * Choose the on-the-clock manager's auto-pick, or null if nothing is draftable
 * (corpus exhausted). Targets the scarcest uncovered mandatory slot; once every
 * mandatory slot is covered, fills the bench with the best available wildcard.
 */
export async function chooseAutoPick(
  db: Db,
  leagueId: string,
  userId: string,
  cfg: RosterConfig,
): Promise<AutoPick | null> {
  const mandatory = await scarcityOrderedSlots(db, cfg);
  const owned = await loadOwned(db, leagueId, userId);
  const uncovered = uncoveredSlots(mandatory, owned);

  // Slots to try in order: the uncovered mandatory ones first (need), then a
  // wildcard bench filler, then any remaining mandatory slot as a fallback so a
  // pick is always returned while inventory remains.
  const targets = [...uncovered, 'Wildcard', ...mandatory];
  for (const slot of targets) {
    const symbol = await bestAvailableFor(db, leagueId, slot);
    if (symbol) return { symbol, isShort: slot === 'Defense', slot };
  }
  return null;
}
