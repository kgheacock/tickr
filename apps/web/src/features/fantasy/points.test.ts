import { describe, it, expect } from 'vitest';
import { fmtPoints, fmtPercent, signOf } from './points';

describe('fmtPoints', () => {
  it('prefixes a plus on gains and a true minus on losses', () => {
    expect(fmtPoints(1.2)).toBe('+1.20');
    expect(fmtPoints(-2.5)).toBe('−2.50'); // U+2212, not a hyphen
  });

  it('renders zero neutral — no sign', () => {
    expect(fmtPoints(0)).toBe('0.00');
    expect(fmtPoints(-0.001)).toBe('0.00'); // rounds to zero, so no sign
  });

  it('shows a dash when the figure is missing', () => {
    expect(fmtPoints(null)).toBe('—');
    expect(fmtPoints(undefined)).toBe('—');
  });
});

describe('fmtPercent', () => {
  it('signs the value and keeps the percent suffix', () => {
    expect(fmtPercent(0.87)).toBe('+0.87%');
    expect(fmtPercent(-1.93)).toBe('−1.93%');
    expect(fmtPercent(0)).toBe('0.00%');
    expect(fmtPercent(null)).toBe('—');
  });
});

describe('signOf', () => {
  it('buckets on the displayed (2 dp) value so colour matches the text', () => {
    expect(signOf(0.01)).toBe('pos');
    expect(signOf(-0.01)).toBe('neg');
    expect(signOf(0)).toBe('flat');
    expect(signOf(0.004)).toBe('flat'); // rounds to 0.00 → neutral
    expect(signOf(null)).toBe('flat');
    expect(signOf(undefined)).toBe('flat');
  });
});
