/**
 * Fantasy Street item 04 — weekly lineup auto-fill.
 *
 * Fills a manager's empty *mandatory* slots from their own drafted roster
 * (fs_roster_entry), never from the corpus — unlike auto-draft (autodraft.ts),
 * which picks unowned stocks. Shared by the explicit "auto-fill remaining"
 * action and by the Monday lock job (lock.ts), so an untouched manager still
 * fields a complete, legal lineup (DoD: no empty mandatory slot).
 *
 * Slot rules mirror lineup validation: the slot defines the basis — Defense is a
 * short that any owned stock may fill (converted to a short for the week), while
 * every other (long) slot takes a long matching that slot's classification.
 * Ranking is the stored trailing-3-month return (`ret3mPct`): the highest for a
 * long slot, the most negative for a Defense short (a short scores the inverse,
 * so the worst performer is the best pick). Bench is never auto-filled.
 */
import type { Pool, PoolClient } from 'pg';
import type { RosterConfig } from '@tickr/shared-types';

type Db = Pool | PoolClient;

/** A position in the roster grid: a slot label plus its duplicate index. */
export interface SlotRef {
  slot: string;
  slotIndex: number;
}

/** A resolved auto-fill placement. */
export interface FilledSlot extends SlotRef {
  symbol: string;
  isShort: boolean;
}

/** A roster entry the manager owns, with what it can start and how it ranks. */
export interface OwnedEntry {
  symbol: string;
  /** Lower-cased eligible classification groups (anchor/growth/…); no universal. */
  groups: string[];
  /** Trailing 3-month return %, or null when unclassified. */
  ret3m: number | null;
}

/** Expand a roster config's starting slots into indexed positions (lower-case). */
export function mandatorySlots(cfg: RosterConfig): SlotRef[] {
  const counts = new Map<string, number>();
  const out: SlotRef[] = [];
  for (const raw of cfg.slots) {
    const slot = raw.trim().toLowerCase();
    const slotIndex = counts.get(slot) ?? 0;
    counts.set(slot, slotIndex + 1);
    out.push({ slot, slotIndex });
  }
  return out;
}

/** Whether a non-short owned entry may start in a (non-Defense) long slot. */
function longFits(slot: string, groups: string[]): boolean {
  // Wildcard is universal for longs; other slots need the matching group.
  return slot === 'wildcard' || groups.includes(slot);
}

/** The owned entries that can legally fill `slot`. The slot defines the basis:
 *  Defense accepts any owned stock (converted to a short); a long slot needs the
 *  matching classification (Wildcard is universal for longs). */
function candidatesFor(
  slot: string,
  owned: OwnedEntry[],
  used: ReadonlySet<string>,
): OwnedEntry[] {
  const isDefense = slot === 'defense';
  return owned.filter((o) => {
    if (used.has(o.symbol)) return false;
    if (isDefense) return true; // any owned stock can be shorted into Defense
    return longFits(slot, o.groups);
  });
}

/** Best candidate by return: highest for a long, most-negative for Defense. */
function pickBest(cands: OwnedEntry[], isDefense: boolean): OwnedEntry {
  return [...cands].sort((a, b) => {
    if (a.ret3m === null && b.ret3m === null) {
      return a.symbol.localeCompare(b.symbol);
    }
    if (a.ret3m === null) return 1;
    if (b.ret3m === null) return -1;
    if (a.ret3m !== b.ret3m) {
      return isDefense ? a.ret3m - b.ret3m : b.ret3m - a.ret3m;
    }
    return a.symbol.localeCompare(b.symbol);
  })[0]!;
}

/**
 * Pure core: choose fills for `emptySlots` from `owned`, never starting a symbol
 * already in `alreadyUsed` or assigned earlier in this pass. Most-constrained
 * slot first (fewest live candidates), so a scarce slot isn't stranded by a
 * symbol that a looser slot could have taken — the same guard auto-draft uses.
 */
export function chooseAutofill(
  emptySlots: SlotRef[],
  owned: OwnedEntry[],
  alreadyUsed: ReadonlySet<string> = new Set(),
): FilledSlot[] {
  const used = new Set(alreadyUsed);
  const remaining = [...emptySlots];
  const fills: FilledSlot[] = [];

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestCands = candidatesFor(remaining[0]!.slot, owned, used);
    for (let i = 1; i < remaining.length; i++) {
      const cands = candidatesFor(remaining[i]!.slot, owned, used);
      if (cands.length < bestCands.length) {
        bestIdx = i;
        bestCands = cands;
      }
    }
    const ref = remaining.splice(bestIdx, 1)[0]!;
    if (bestCands.length === 0) continue; // no option — leave empty
    const pick = pickBest(bestCands, ref.slot === 'defense');
    used.add(pick.symbol);
    fills.push({
      slot: ref.slot,
      slotIndex: ref.slotIndex,
      symbol: pick.symbol,
      isShort: ref.slot === 'defense', // the slot defines the basis
    });
  }
  return fills;
}

/** Load a manager's roster with eligibility groups and the ranking return. */
export async function loadOwnedForLineup(
  db: Db,
  leagueId: string,
  userId: string,
): Promise<OwnedEntry[]> {
  const { rows } = await db.query<{
    symbol: string;
    groups: string[] | null;
    ret3m: number | null;
  }>(
    `SELECT re.symbol,
            array_remove(array_agg(c."group") FILTER (WHERE c.eligible), NULL)
              AS groups,
            max((c.metrics->>'ret3mPct')::float) AS ret3m
       FROM fs_roster_entry re
       LEFT JOIN fs_player_classification c ON c.symbol = re.symbol
      WHERE re.league_id = $1 AND re.user_id = $2
      GROUP BY re.symbol`,
    [leagueId, userId],
  );
  return rows.map((r) => ({
    symbol: r.symbol,
    groups: r.groups ?? [],
    ret3m: r.ret3m,
  }));
}

/**
 * Resolve the auto-fill placements for a manager's empty mandatory slots, given
 * what they have already set. The caller persists the returned rows; this does
 * not write. Returns [] when nothing needs filling (already complete).
 */
export async function autofillLineup(
  db: Db,
  leagueId: string,
  userId: string,
  cfg: RosterConfig,
  existing: { slot: string; slotIndex: number; symbol: string }[],
): Promise<FilledSlot[]> {
  const filledKeys = new Set(existing.map((s) => `${s.slot}#${s.slotIndex}`));
  const empty = mandatorySlots(cfg).filter(
    (m) => !filledKeys.has(`${m.slot}#${m.slotIndex}`),
  );
  if (empty.length === 0) return [];
  const owned = await loadOwnedForLineup(db, leagueId, userId);
  const used = new Set(existing.map((s) => s.symbol));
  return chooseAutofill(empty, owned, used);
}
