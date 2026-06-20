/**
 * Fantasy Street client surface for the dashboard (item 09). The dashboard
 * composes the read endpoints built in items 01–08 (`client` already carries
 * the auth cookie + CSRF) and overlays the live `scores.updated` topic; it adds
 * no new backend domain logic. This module centralizes the React Query keys, the
 * weekly-ranking derivation, and the small client-side helpers the views share.
 */
import type {
  LeagueMember,
  PlayerGroup,
  WeeklyScore,
} from '@tickr/shared-types';

export const DEFAULT_SEASON = 1;
// The scoring week is single-week server-side today (returns.ts currentWeek()
// === 1); the dashboard defaults here.
export const DEFAULT_WEEK = 1;

/** Stable React Query keys, scoped by league so a refetch is surgical. */
export const fantasyKeys = {
  myLeagues: ['fantasy', 'leagues', 'mine'] as const,
  league: (id: string) => ['fantasy', 'league', id] as const,
  lineup: (id: string, week: number, season: number) =>
    ['fantasy', 'lineup', id, season, week] as const,
  scores: (id: string, week: number, season: number) =>
    ['fantasy', 'scores', id, season, week] as const,
  wins: (id: string, season: number) =>
    ['fantasy', 'wins', id, season] as const,
  notifications: (id: string) => ['fantasy', 'notifications', id] as const,
};

/** One manager's place in a league week, ranked by weekly points. */
export interface RankedManager {
  userId: string;
  totalPoints: number;
  /** 1-based placement; ties share a rank (standard competition ranking). */
  rank: number;
}

/**
 * The weekly ranking: managers ordered high→low by weekly points, each tagged
 * with a 1-based rank. Ties share a rank and the next rank skips accordingly
 * (e.g. 1, 2, 2, 4). Mirrors the server's rankScores so the live board reads the
 * same as the eventual settle without a round-trip.
 */
export function rankScores(scores: WeeklyScore[]): RankedManager[] {
  const ordered = [...scores].sort(
    (a, b) => b.totalPoints - a.totalPoints || (a.userId < b.userId ? -1 : 1),
  );
  let prevPoints: number | null = null;
  let prevRank = 0;
  return ordered.map((s, i) => {
    const rank =
      prevPoints !== null && s.totalPoints === prevPoints ? prevRank : i + 1;
    prevPoints = s.totalPoints;
    prevRank = rank;
    return { userId: s.userId, totalPoints: s.totalPoints, rank };
  });
}

/** A manager's team name, falling back to display name, then a short id. */
export function managerLabel(
  members: Map<string, LeagueMember>,
  userId: string | null | undefined,
): string {
  if (!userId) return '—';
  const m = members.get(userId);
  return m?.teamName ?? m?.displayName ?? userId.slice(0, 8);
}

/** Slot labels for the canonical roster order (long slots, then Defense). */
export const SLOT_LABELS: Record<string, string> = {
  anchor: 'Anchor',
  growth: 'Growth',
  momentum: 'Momentum',
  value: 'Value',
  defense: 'Defense',
  wildcard: 'Wildcard',
  bench: 'Bench',
};

/**
 * Universal groups every tradeable stock qualifies for (mirrors eligibility.ts
 * UNIVERSAL on the server). They're roster slots, not earned classifications, so
 * the UI hides them from the per-stock "Specialization" chips — every row would
 * carry them, which is noise.
 */
export const GLOBAL_GROUPS: ReadonlySet<PlayerGroup> = new Set([
  'defense',
  'wildcard',
]);

/** The earned, price-derived groups — i.e. all groups minus the global slots. */
export const SPECIALIZATIONS: PlayerGroup[] = [
  'anchor',
  'growth',
  'momentum',
  'value',
];

/** A stock's specializations: its groups with the universal slots removed. */
export function specializationsOf(groups: PlayerGroup[]): PlayerGroup[] {
  return groups.filter((g) => !GLOBAL_GROUPS.has(g));
}

/** Every classification group (specializations + globals). */
const ALL_GROUPS: ReadonlySet<string> = new Set<PlayerGroup>([
  ...SPECIALIZATIONS,
  ...GLOBAL_GROUPS,
]);

/** Narrow a roster-slot string to a coloured group (excludes 'bench'). */
export function isPlayerGroup(slot: string): slot is PlayerGroup {
  return ALL_GROUPS.has(slot);
}
