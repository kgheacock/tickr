import { describe, it, expect } from 'vitest';
import type { WeeklyScore } from '@tickr/shared-types';
import { tallyWins } from '../../src/fantasy/wins.js';

/** Minimal WeeklyScore — tallyWins only reads userId, week and totalPoints. */
function score(userId: string, week: number, totalPoints: number): WeeklyScore {
  return {
    leagueId: 'L',
    userId,
    season: 1,
    week,
    totalPoints,
    provisional: false,
    computedAt: '',
    breakdown: [],
  };
}

describe('tallyWins', () => {
  it('counts the top finisher of each week as a win', () => {
    const { weeks, entries } = tallyWins([
      // Week 1: a wins, Week 2: b wins, Week 3: a wins
      score('a', 1, 10),
      score('b', 1, 5),
      score('a', 2, 1),
      score('b', 2, 9),
      score('a', 3, 7),
      score('b', 3, 2),
    ]);
    expect(weeks).toBe(3);
    expect(entries).toEqual([
      { userId: 'a', wins: 2, weeksPlayed: 3, pointsFor: 18 },
      { userId: 'b', wins: 1, weeksPlayed: 3, pointsFor: 16 },
    ]);
  });

  it('gives every co-leader a win on a tie at the top', () => {
    const { entries } = tallyWins([
      score('a', 1, 8),
      score('b', 1, 8),
      score('c', 1, 3),
    ]);
    expect(entries.map((e) => [e.userId, e.wins])).toEqual([
      ['a', 1],
      ['b', 1],
      ['c', 0],
    ]);
  });

  it('orders by wins, then points-for, then userId', () => {
    const { entries } = tallyWins([
      // a and b both win one week; b has more points-for, so b leads.
      score('a', 1, 6),
      score('b', 1, 4),
      score('a', 2, 4),
      score('b', 2, 12),
    ]);
    expect(entries.map((e) => e.userId)).toEqual(['b', 'a']);
    expect(entries[0]).toMatchObject({ userId: 'b', wins: 1, pointsFor: 16 });
  });

  it('counts negative weekly totals — the high score still wins', () => {
    const { entries } = tallyWins([score('a', 1, -2), score('b', 1, -9)]);
    expect(entries[0]).toMatchObject({ userId: 'a', wins: 1 });
    expect(entries[1]).toMatchObject({ userId: 'b', wins: 0 });
  });

  it('rounds running points-for to two decimals', () => {
    const { entries } = tallyWins([score('a', 1, 0.1), score('a', 2, 0.2)]);
    expect(entries[0].pointsFor).toBe(0.3);
  });

  it('returns no entries before any week settles', () => {
    expect(tallyWins([])).toEqual({ weeks: 0, entries: [] });
  });
});
