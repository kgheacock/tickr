import { describe, it, expect } from 'vitest';
import { dailyCloses, weeklyMarkers } from './priceSeries';

// 2024-01-01 is a Monday; the window below spans three Monday-aligned weeks.
const bars = [
  { ts: '2024-01-01T00:00:00Z', close: 100 }, // wk1 Mon (window open)
  { ts: '2024-01-03T00:00:00Z', close: 110 }, // wk1 Wed
  { ts: '2024-01-05T00:00:00Z', close: 120 }, // wk1 Fri (week close)
  { ts: '2024-01-08T00:00:00Z', close: 130 }, // wk2 Mon
  { ts: '2024-01-12T00:00:00Z', close: 150 }, // wk2 Fri (week close)
  { ts: '2024-01-15T00:00:00Z', close: 135 }, // wk3 Mon (week close)
];

describe('dailyCloses', () => {
  it('keeps the last close per calendar day, ascending', () => {
    const dupes = [
      { ts: '2024-01-03T14:00:00Z', close: 110 },
      { ts: '2024-01-03T20:00:00Z', close: 112 }, // later same-day bar wins
      { ts: '2024-01-01T00:00:00Z', close: 100 },
    ];
    expect(dailyCloses(dupes)).toEqual([
      { ts: '2024-01-01T00:00:00Z', close: 100 },
      { ts: '2024-01-03T20:00:00Z', close: 112 },
    ]);
  });
});

describe('weeklyMarkers', () => {
  it('drops one signpost per week at the week-end bar', () => {
    expect(weeklyMarkers(bars).map((m) => m.ts)).toEqual([
      '2024-01-05T00:00:00Z',
      '2024-01-12T00:00:00Z',
      '2024-01-15T00:00:00Z',
    ]);
  });

  it('captions each week with its move (percent units)', () => {
    const pct = weeklyMarkers(bars).map((m) => m.changePct);
    // wk1: 120 vs window open 100 = +20%
    // wk2: 150 vs prior week close 120 = +25%
    // wk3: 135 vs prior week close 150 = -10%
    expect(pct[0]).toBeCloseTo(20, 5);
    expect(pct[1]).toBeCloseTo(25, 5);
    expect(pct[2]).toBeCloseTo(-10, 5);
  });

  it('is empty with no bars', () => {
    expect(weeklyMarkers([])).toEqual([]);
  });
});
