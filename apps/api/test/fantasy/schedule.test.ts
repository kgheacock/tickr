import { describe, it, expect } from 'vitest';
import {
  roundRobinSchedule,
  type Pairing,
} from '../../src/fantasy/schedule.js';

/** Canonical unordered key for a (home, away) pair, ignoring venue. */
function pairKey(p: Pairing): string {
  return [p.home, p.away ?? 'BYE'].sort().join('|');
}

describe('roundRobinSchedule', () => {
  it('covers every pairing exactly once within one full cycle (even size)', () => {
    const managers = ['a', 'b', 'c', 'd'];
    const sched = roundRobinSchedule(managers, 3); // n-1 = 3 rounds
    expect(sched).toHaveLength(3);
    sched.forEach((week) => expect(week).toHaveLength(2)); // 4 managers → 2 games

    const seen = sched.flat().map(pairKey);
    // C(4,2) = 6 distinct pairings, each once, no repeats.
    expect(new Set(seen).size).toBe(6);
    expect(seen).toHaveLength(6);
  });

  it('every manager plays once per week and never themselves (even size)', () => {
    const managers = ['a', 'b', 'c', 'd', 'e', 'f'];
    const sched = roundRobinSchedule(managers, 5);
    sched.forEach((week) => {
      const playing = week.flatMap((p) => [p.home, p.away]).filter(Boolean);
      expect(new Set(playing).size).toBe(6); // each manager exactly once
      week.forEach((p) => expect(p.home).not.toBe(p.away));
    });
  });

  it('gives an odd-sized league exactly one rotating bye per week', () => {
    const managers = ['a', 'b', 'c', 'd', 'e'];
    const sched = roundRobinSchedule(managers, 5); // odd: n=5 → 5 rounds
    expect(sched).toHaveLength(5);

    const byeManagers: string[] = [];
    sched.forEach((week) => {
      const byes = week.filter((p) => p.away === null);
      expect(byes).toHaveLength(1); // exactly one bye each week
      byeManagers.push(byes[0]!.home);
    });
    // Over a full cycle every manager sits exactly once — the bye rotates.
    expect(new Set(byeManagers).size).toBe(5);
    expect(new Set(byeManagers)).toEqual(new Set(managers));
  });

  it('wraps for seasons longer than one cycle (double round-robin)', () => {
    const managers = ['a', 'b', 'c', 'd'];
    const sched = roundRobinSchedule(managers, 6); // two full 3-round cycles
    expect(sched).toHaveLength(6);

    // Each unordered pair is played exactly twice across the two cycles.
    const counts = new Map<string, number>();
    sched.flat().forEach((p) => {
      const k = pairKey(p);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    });
    expect(counts.size).toBe(6);
    [...counts.values()].forEach((c) => expect(c).toBe(2));

    // …and the repeat swaps venue: a pair that was home in cycle 1 is away in 2.
    const firstHalf = sched.slice(0, 3).flat();
    const secondHalf = sched.slice(3).flat();
    firstHalf.forEach((p) => {
      const mirror = secondHalf.find((q) => pairKey(q) === pairKey(p))!;
      expect(mirror.home).toBe(p.away);
      expect(mirror.away).toBe(p.home);
    });
  });

  it('is deterministic for a fixed manager order', () => {
    const managers = ['x', 'y', 'z', 'w'];
    expect(roundRobinSchedule(managers, 3)).toEqual(
      roundRobinSchedule(managers, 3),
    );
  });

  it('returns nothing for a degenerate league', () => {
    expect(roundRobinSchedule(['a'], 4)).toEqual([]);
    expect(roundRobinSchedule(['a', 'b'], 0)).toEqual([]);
  });
});
