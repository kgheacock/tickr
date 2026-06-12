import { describe, it, expect } from 'vitest';
import {
  splitLabel,
  isTradingDay,
  computeExpectedTradingDays,
  findCoverageGaps,
  buildBucketExpr,
  findTransitionPredecessor,
  isCoverageRegression,
} from '../../src/audit/run-audit.js';
import type { CoverageGap } from '../../src/audit/run-audit.js';

// ─── splitLabel ───────────────────────────────────────────────────────────────

describe('splitLabel', () => {
  it('2:1 forward split (ratio ≈ 0.5)', () => {
    expect(splitLabel(0.5)).toBe('2:1 forward split');
  });
  it('3:1 forward split (ratio ≈ 0.333)', () => {
    expect(splitLabel(1 / 3)).toBe('3:1 forward split');
  });
  it('4:1 forward split (ratio ≈ 0.25)', () => {
    expect(splitLabel(0.25)).toBe('4:1 forward split');
  });
  it('1:2 reverse split (ratio ≈ 2.0)', () => {
    expect(splitLabel(2.0)).toBe('1:2 reverse split');
  });
  it('1:10 reverse split (ratio ≈ 10.0)', () => {
    expect(splitLabel(10.0)).toBe('1:10 reverse split');
  });
});

// ─── isTradingDay ─────────────────────────────────────────────────────────────

describe('isTradingDay', () => {
  it('normal weekday is a trading day', () => {
    expect(isTradingDay('2024-07-08')).toBe(true); // Monday
  });
  it('Saturday is not a trading day', () => {
    expect(isTradingDay('2024-07-06')).toBe(false);
  });
  it('Sunday is not a trading day', () => {
    expect(isTradingDay('2024-07-07')).toBe(false);
  });
  it('NYSE holiday (Independence Day 2024-07-04) is not a trading day', () => {
    expect(isTradingDay('2024-07-04')).toBe(false);
  });
  it('day after Independence Day is a trading day', () => {
    expect(isTradingDay('2024-07-05')).toBe(true); // Friday
  });
  // Regression: midnight UTC → prior ET date would misclassify holidays.
  // isTradingDay uses noon UTC to pin the correct calendar date in ET.
  it('Christmas 2024 is not a trading day', () => {
    expect(isTradingDay('2024-12-25')).toBe(false);
  });
});

// ─── computeExpectedTradingDays ───────────────────────────────────────────────

describe('computeExpectedTradingDays', () => {
  it('returns only trading days in range', () => {
    const start = new Date('2024-01-08T00:00:00Z').getTime();
    const end = new Date('2024-01-12T00:00:00Z').getTime();
    const days = computeExpectedTradingDays(start, end);
    expect(days).toEqual([
      '2024-01-08',
      '2024-01-09',
      '2024-01-10',
      '2024-01-11',
      '2024-01-12',
    ]);
  });

  it('excludes the weekend between two weeks', () => {
    // 2024-01-15 is MLK Day — use Tue 2024-01-16 as the end so the first
    // post-weekend trading day is included and we confirm weekend days are skipped.
    const start = new Date('2024-01-12T00:00:00Z').getTime(); // Fri
    const end = new Date('2024-01-16T00:00:00Z').getTime(); // Tue (Mon is MLK Day)
    const days = computeExpectedTradingDays(start, end);
    expect(days).toEqual(['2024-01-12', '2024-01-16']);
  });

  it('excludes NYSE holiday (MLK Day 2024-01-15)', () => {
    const start = new Date('2024-01-12T00:00:00Z').getTime();
    const end = new Date('2024-01-16T00:00:00Z').getTime();
    const days = computeExpectedTradingDays(start, end);
    expect(days).not.toContain('2024-01-15');
    expect(days).toContain('2024-01-16');
  });
});

// ─── findCoverageGaps ─────────────────────────────────────────────────────────

describe('findCoverageGaps', () => {
  const days = [
    '2024-01-08', // Mon
    '2024-01-09', // Tue
    '2024-01-10', // Wed
    '2024-01-11', // Thu
    '2024-01-12', // Fri
    '2024-01-16', // Mon (post-holiday)
    '2024-01-17', // Tue
    '2024-01-18', // Wed
    '2024-01-19', // Thu
    '2024-01-22', // Mon
  ];

  it('no gaps when all days present', () => {
    const present = new Set(days);
    expect(findCoverageGaps(days, present, 3)).toEqual([]);
  });

  it('does not flag a gap below threshold', () => {
    const present = new Set(days.filter((d) => d !== '2024-01-11')); // 1 day missing
    expect(findCoverageGaps(days, present, 2)).toEqual([]);
  });

  it('flags a gap exactly at threshold', () => {
    const present = new Set(
      days.filter((d) => d !== '2024-01-11' && d !== '2024-01-12'),
    );
    const gaps = findCoverageGaps(days, present, 2);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      gapStart: '2024-01-11',
      gapEnd: '2024-01-12',
      missingTradingDays: 2,
    });
  });

  it('detects a trailing gap at end of range', () => {
    const present = new Set(days.slice(0, days.length - 3));
    const gaps = findCoverageGaps(days, present, 3);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.missingTradingDays).toBe(3);
  });

  it('detects multiple disjoint gaps', () => {
    const present = new Set(
      days.filter(
        (d) =>
          d !== '2024-01-10' &&
          d !== '2024-01-11' &&
          d !== '2024-01-17' &&
          d !== '2024-01-18',
      ),
    );
    const gaps = findCoverageGaps(days, present, 2);
    expect(gaps).toHaveLength(2);
  });

  it('classifies a trailing gap (symbol stops before window end)', () => {
    const present = new Set(days.slice(0, days.length - 3));
    const gaps = findCoverageGaps(days, present, 3);
    expect(gaps[0]?.position).toBe('trailing');
  });

  it('classifies a leading gap (history starts late)', () => {
    const present = new Set(days.slice(3));
    const gaps = findCoverageGaps(days, present, 3);
    expect(gaps[0]?.position).toBe('leading');
  });

  it('classifies an internal gap (hole in the middle)', () => {
    const present = new Set(
      days.filter(
        (d) => d !== '2024-01-10' && d !== '2024-01-11' && d !== '2024-01-12',
      ),
    );
    const gaps = findCoverageGaps(days, present, 3);
    expect(gaps[0]?.position).toBe('internal');
  });
});

// ─── findTransitionPredecessor ────────────────────────────────────────────────

describe('findTransitionPredecessor', () => {
  const expectedDays = [
    '2024-01-08',
    '2024-01-09',
    '2024-01-10',
    '2024-01-11',
    '2024-01-12',
  ];
  // Internal gap: the middle three days are missing on the active symbol, so
  // '2024-01-12' is a post-gap day a still-trading predecessor would cover.
  const gap: CoverageGap = {
    gapStart: '2024-01-09',
    gapEnd: '2024-01-11',
    missingTradingDays: 3,
    position: 'internal',
  };

  it('returns the retired predecessor that covers the gap and goes dark after it', () => {
    const symbolDates = new Map([
      ['BK', new Set(['2024-01-09', '2024-01-10', '2024-01-11'])],
    ]);
    expect(
      findTransitionPredecessor(
        gap,
        ['BK'],
        symbolDates,
        expectedDays,
        0.9,
        0.1,
      ),
    ).toBe('BK');
  });

  it('returns null when no candidate covers enough of the gap', () => {
    const symbolDates = new Map([
      ['BK', new Set(['2024-01-09'])], // only 1 of 3 gap days
    ]);
    expect(
      findTransitionPredecessor(
        gap,
        ['BK'],
        symbolDates,
        expectedDays,
        0.9,
        0.1,
      ),
    ).toBeNull();
  });

  it('returns null when there are no retired candidates', () => {
    const symbolDates = new Map([
      ['OTHR', new Set(['2024-01-09', '2024-01-10', '2024-01-11'])],
    ]);
    expect(
      findTransitionPredecessor(gap, [], symbolDates, expectedDays, 0.9, 0.1),
    ).toBeNull();
  });

  // Adjacency guard: a deindexed-but-still-trading symbol (AAL) covers the gap
  // window yet keeps printing bars past it. It must NOT be treated as a
  // predecessor, or genuine data loss on a live symbol could be silently
  // downgraded.
  it('rejects a candidate that covers the gap but keeps trading past it', () => {
    const symbolDates = new Map([
      [
        'AAL',
        // Covers all three gap days AND the post-gap day 2024-01-12.
        new Set(['2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12']),
      ],
    ]);
    expect(
      findTransitionPredecessor(
        gap,
        ['AAL'],
        symbolDates,
        expectedDays,
        0.9,
        0.1,
      ),
    ).toBeNull();
  });

  // The real predecessor (BK, went dark) is chosen over a coincidental cover
  // (AAL, still trading) — and the still-trading one alone never qualifies.
  it('picks the dark predecessor and ignores a still-trading coincidental cover', () => {
    const symbolDates = new Map([
      [
        'AAL',
        new Set(['2024-01-09', '2024-01-10', '2024-01-11', '2024-01-12']),
      ],
      ['BK', new Set(['2024-01-09', '2024-01-10', '2024-01-11'])],
    ]);
    expect(
      findTransitionPredecessor(
        gap,
        ['AAL', 'BK'],
        symbolDates,
        expectedDays,
        0.9,
        0.1,
      ),
    ).toBe('BK');
  });

  // Fail closed on ambiguity: two distinct dark predecessors both covering the
  // gap is not a confident attribution, so the gap stays an error.
  it('returns null when more than one candidate qualifies (ambiguous)', () => {
    const covering = new Set(['2024-01-09', '2024-01-10', '2024-01-11']);
    const symbolDates = new Map([
      ['BK', new Set(covering)],
      ['XYZ', new Set(covering)],
    ]);
    expect(
      findTransitionPredecessor(
        gap,
        ['BK', 'XYZ'],
        symbolDates,
        expectedDays,
        0.9,
        0.1,
      ),
    ).toBeNull();
  });

  it('returns null for a trailing gap (no post-gap days to confirm a handoff)', () => {
    const trailingGap: CoverageGap = {
      gapStart: '2024-01-10',
      gapEnd: '2024-01-12', // == last expected day → trailing
      missingTradingDays: 3,
      position: 'trailing',
    };
    const symbolDates = new Map([
      ['BK', new Set(['2024-01-10', '2024-01-11', '2024-01-12'])],
    ]);
    expect(
      findTransitionPredecessor(
        trailingGap,
        ['BK'],
        symbolDates,
        expectedDays,
        0.9,
        0.1,
      ),
    ).toBeNull();
  });

  it('tolerates a single missing gap day at the 0.9 threshold', () => {
    // 9 of 10 gap days covered = 0.9, exactly the threshold. A trailing post-gap
    // day keeps the window internal so adjacency can be evaluated.
    const elevenDays = Array.from(
      { length: 11 },
      (_, i) => `2024-02-${String(i + 1).padStart(2, '0')}`,
    );
    const wideGap: CoverageGap = {
      gapStart: elevenDays[0]!,
      gapEnd: elevenDays[9]!,
      missingTradingDays: 10,
      position: 'internal',
    };
    const symbolDates = new Map([['BK', new Set(elevenDays.slice(0, 9))]]);
    expect(
      findTransitionPredecessor(
        wideGap,
        ['BK'],
        symbolDates,
        elevenDays,
        0.9,
        0.1,
      ),
    ).toBe('BK');
  });
});

// ─── isCoverageRegression ─────────────────────────────────────────────────────

describe('isCoverageRegression', () => {
  it('a full-coverage re-run (1.0 vs 1.0) is not a regression', () => {
    expect(isCoverageRegression(1.0, 1.0, 0.02)).toBe(false);
  });

  it('a drop beyond tolerance is a regression', () => {
    expect(isCoverageRegression(0.8, 1.0, 0.02)).toBe(true);
  });

  it('a drop within tolerance is not a regression (absorbs window jitter)', () => {
    expect(isCoverageRegression(0.99, 1.0, 0.02)).toBe(false);
  });

  it('exactly at the tolerance edge is not a regression', () => {
    expect(isCoverageRegression(0.98, 1.0, 0.02)).toBe(false);
  });

  it('a stable partial-coverage symbol (late listing) does not regress', () => {
    // A symbol that has only ever reached 0.6 coverage holds at 0.6.
    expect(isCoverageRegression(0.6, 0.6, 0.02)).toBe(false);
  });
});

// ─── buildBucketExpr ──────────────────────────────────────────────────────────

describe('buildBucketExpr', () => {
  it('daily → date_trunc day', () => {
    expect(buildBucketExpr(1, 'day')).toBe(`date_trunc('day', ts)`);
  });
  it('1h → date_trunc hour', () => {
    expect(buildBucketExpr(1, 'hour')).toBe(`date_trunc('hour', ts)`);
  });
  it('15 minute → inlines multiplier', () => {
    const expr = buildBucketExpr(15, 'minute');
    expect(expr).toContain('15');
    expect(expr).toContain('minute');
  });
  it('30 minute → inlines 30', () => {
    expect(buildBucketExpr(30, 'minute')).toContain('30');
  });
});
