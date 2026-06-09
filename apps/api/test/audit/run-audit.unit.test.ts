import { describe, it, expect } from 'vitest';
import {
  splitLabel,
  isTradingDay,
  computeExpectedTradingDays,
  findCoverageGaps,
  buildBucketExpr,
} from '../../src/audit/run-audit.js';

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
