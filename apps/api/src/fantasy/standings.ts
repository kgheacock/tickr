/**
 * Fantasy Street item 06 — standings (pure derivation).
 *
 * Standings are always derived from settled matchups; fs_standings is only a
 * read cache rebuilt from this. `computeStandings` folds a league's final
 * matchups into per-manager W/L/T + points and ranks them by the documented
 * tiebreaker order. Pure (no DB) so the ordering is unit-testable; see
 * test/fantasy/standings.test.ts.
 *
 * Tiebreakers, in order: win% → points-for → head-to-head → points-against
 * (lower better) → user_id (deterministic final). A bye is a no-contest: it
 * contributes no win/loss/tie and no points-for/against.
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A settled (or scheduled) matchup as standings reads it. */
export interface StandingMatchup {
  homeUserId: string;
  awayUserId: string | null;
  homePoints: number | null;
  awayPoints: number | null;
  winnerUserId: string | null;
  status: 'scheduled' | 'final';
}

export interface Standing {
  userId: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  rank: number;
}

/** Ties count as half a win, the conventional fantasy win-percentage. */
function winPct(s: Standing): number {
  const games = s.wins + s.losses + s.ties;
  return games === 0 ? 0 : (s.wins + s.ties * 0.5) / games;
}

/**
 * Order two managers by the tiebreaker chain. `h2h` maps "a beat b" counts
 * (key `${winner}|${loser}`); only the pairwise (2-way) head-to-head case is
 * resolved here — a 3+-way cycle falls through to points-against then user_id,
 * which keeps the sort total and deterministic.
 */
function compareStandings(
  a: Standing,
  b: Standing,
  h2h: Map<string, number>,
): number {
  const wa = winPct(a);
  const wb = winPct(b);
  if (wa !== wb) return wb - wa;
  if (a.pointsFor !== b.pointsFor) return b.pointsFor - a.pointsFor;

  const aOverB = h2h.get(`${a.userId}|${b.userId}`) ?? 0;
  const bOverA = h2h.get(`${b.userId}|${a.userId}`) ?? 0;
  if (aOverB !== bOverA) return bOverA - aOverB;

  if (a.pointsAgainst !== b.pointsAgainst) {
    return a.pointsAgainst - b.pointsAgainst; // lower points-against ranks higher
  }
  return a.userId < b.userId ? -1 : 1;
}

/**
 * Rank a league's managers from its final matchups. Every member is included
 * (a manager with no settled games sits at 0–0–0); scheduled and bye rows are
 * skipped. Returns the standings in rank order with `rank` set 1..n.
 */
export function computeStandings(
  memberIds: string[],
  matchups: StandingMatchup[],
): Standing[] {
  const rec = new Map<string, Standing>();
  for (const id of memberIds) {
    rec.set(id, {
      userId: id,
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      rank: 0,
    });
  }

  const h2h = new Map<string, number>();
  const bumpH2H = (winner: string, loser: string): void => {
    const key = `${winner}|${loser}`;
    h2h.set(key, (h2h.get(key) ?? 0) + 1);
  };

  for (const m of matchups) {
    if (m.status !== 'final' || m.awayUserId === null) continue; // bye = no-contest
    const home = rec.get(m.homeUserId);
    const away = rec.get(m.awayUserId);
    if (!home || !away) continue;

    const hp = m.homePoints ?? 0;
    const ap = m.awayPoints ?? 0;
    home.pointsFor = round2(home.pointsFor + hp);
    home.pointsAgainst = round2(home.pointsAgainst + ap);
    away.pointsFor = round2(away.pointsFor + ap);
    away.pointsAgainst = round2(away.pointsAgainst + hp);

    if (m.winnerUserId === m.homeUserId) {
      home.wins += 1;
      away.losses += 1;
      bumpH2H(m.homeUserId, m.awayUserId);
    } else if (m.winnerUserId === m.awayUserId) {
      away.wins += 1;
      home.losses += 1;
      bumpH2H(m.awayUserId, m.homeUserId);
    } else {
      home.ties += 1;
      away.ties += 1;
    }
  }

  const ranked = [...rec.values()].sort((a, b) => compareStandings(a, b, h2h));
  ranked.forEach((s, i) => {
    s.rank = i + 1;
  });
  return ranked;
}
