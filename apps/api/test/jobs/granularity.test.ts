import { describe, it, expect } from 'vitest';
import { toMassiveTicker, aggPath } from '../../src/jobs/granularity.js';

describe('toMassiveTicker', () => {
  it('passes ordinary tickers through unchanged', () => {
    expect(toMassiveTicker('AAPL')).toBe('AAPL');
    expect(toMassiveTicker('MSFT')).toBe('MSFT');
  });

  it('maps hyphenated share classes to period notation (audit Finding 4)', () => {
    expect(toMassiveTicker('BRK-B')).toBe('BRK.B');
    expect(toMassiveTicker('MOG-A')).toBe('MOG.A');
  });
});

describe('aggPath', () => {
  it('builds the URL with the translated ticker, not the canonical hyphen form', () => {
    const path = aggPath('BRK-B', '2024-06-09', '2025-06-09');
    expect(path).toContain('/ticker/BRK.B/');
    expect(path).not.toContain('BRK-B');
  });
});
