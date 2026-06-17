/**
 * Fantasy Street client surface for the dashboard (item 09). The dashboard
 * composes the read endpoints built in items 01–08 (`client` already carries
 * the auth cookie + CSRF) and overlays the live `matchup.updated` topic; it adds
 * no new backend domain logic. This module centralizes the React Query keys and
 * the small client-side helpers the views share.
 */
import type {
  LeagueMember,
  Matchup,
  PlayerGroup,
  WeeklyScore,
} from '@tickr/shared-types';

export const DEFAULT_SEASON = 1;
// The schedule→calendar-week mapping is still single-week server-side
// (matchups.ts: currentWeek() === 1); the dashboard defaults here and lets the
// schedule view navigate other weeks once the mapping lands.
export const DEFAULT_WEEK = 1;

/** Stable React Query keys, scoped by league so a refetch is surgical. */
export const fantasyKeys = {
  myLeagues: ['fantasy', 'leagues', 'mine'] as const,
  league: (id: string) => ['fantasy', 'league', id] as const,
  lineup: (id: string, week: number, season: number) =>
    ['fantasy', 'lineup', id, season, week] as const,
  scores: (id: string, week: number, season: number) =>
    ['fantasy', 'scores', id, season, week] as const,
  matchups: (id: string, week: number, season: number) =>
    ['fantasy', 'matchups', id, season, week] as const,
  schedule: (id: string, season: number) =>
    ['fantasy', 'schedule', id, season] as const,
  standings: (id: string, season: number) =>
    ['fantasy', 'standings', id, season] as const,
  notifications: (id: string) => ['fantasy', 'notifications', id] as const,
};

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

/**
 * Higher score wins; equal (or a bye) is a draw. Mirrors the server's
 * settle.ts decideWinner so the live overlay reads the same as the eventual
 * Friday settle without a round-trip.
 */
export function decideWinner(
  homeUserId: string,
  awayUserId: string | null | undefined,
  homePoints: number | null | undefined,
  awayPoints: number | null | undefined,
): string | null {
  if (awayUserId == null) return null; // bye
  if (homePoints == null || awayPoints == null) return null;
  if (homePoints > awayPoints) return homeUserId;
  if (awayPoints > homePoints) return awayUserId;
  return null; // tie
}

/**
 * Overlay live per-manager totals from a `matchup.updated` push onto the REST
 * matchups so the scoreboard moves without a reload. Final matchups are left
 * untouched — only the in-flight week takes the live points.
 */
export function applyLiveScores(
  matchups: Matchup[],
  scores: WeeklyScore[],
): Matchup[] {
  const points = new Map(scores.map((s) => [s.userId, s.totalPoints]));
  return matchups.map((m) => {
    if (m.status === 'final') return m;
    const homePoints = points.get(m.homeUserId) ?? m.homePoints ?? null;
    const awayPoints =
      m.awayUserId == null
        ? null
        : (points.get(m.awayUserId) ?? m.awayPoints ?? null);
    return {
      ...m,
      homePoints,
      awayPoints,
      winnerUserId: decideWinner(
        m.homeUserId,
        m.awayUserId,
        homePoints,
        awayPoints,
      ),
    };
  });
}
