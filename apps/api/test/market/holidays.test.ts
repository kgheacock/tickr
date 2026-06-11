import { describe, it, expect } from 'vitest';
import { isRegularSession, isNyseHoliday } from '../../src/market/holidays.js';

// Helper: build a UTC instant from an explicit offset so the test states the
// intended ET wall-clock directly. EDT = UTC-4 (summer), EST = UTC-5 (winter).
function utc(iso: string): Date {
  return new Date(iso);
}

describe('isRegularSession', () => {
  describe('DST correctness (same ET wall-clock, different UTC)', () => {
    // Wed 2025-07-16 is a normal EDT trading day; 10:00 ET = 14:00 UTC.
    it('open at 10:00 ET in summer (EDT, 14:00 UTC)', () => {
      expect(isRegularSession(utc('2025-07-16T14:00:00Z'))).toBe(true);
    });
    // Same 14:00 UTC in winter (EST) is 09:00 ET — before the open.
    it('closed at 14:00 UTC in winter (EST → 09:00 ET, pre-open)', () => {
      expect(isRegularSession(utc('2025-01-15T14:00:00Z'))).toBe(false);
    });
    // Wed 2025-01-15 winter: 10:00 ET = 15:00 UTC → open.
    it('open at 10:00 ET in winter (EST, 15:00 UTC)', () => {
      expect(isRegularSession(utc('2025-01-15T15:00:00Z'))).toBe(true);
    });
  });

  describe('session edges (EDT day 2025-07-16)', () => {
    it('closed one minute before the open (09:29 ET)', () => {
      expect(isRegularSession(utc('2025-07-16T13:29:00Z'))).toBe(false);
    });
    it('open exactly at 09:30 ET', () => {
      expect(isRegularSession(utc('2025-07-16T13:30:00Z'))).toBe(true);
    });
    it('open at 15:59 ET (one minute before close)', () => {
      expect(isRegularSession(utc('2025-07-16T19:59:00Z'))).toBe(true);
    });
    it('closed exactly at 16:00 ET', () => {
      expect(isRegularSession(utc('2025-07-16T20:00:00Z'))).toBe(false);
    });
  });

  describe('non-trading days', () => {
    it('closed on Saturday', () => {
      // 2025-07-19 is a Saturday; 14:00 UTC = 10:00 ET.
      expect(isRegularSession(utc('2025-07-19T14:00:00Z'))).toBe(false);
    });
    it('closed on Sunday', () => {
      expect(isRegularSession(utc('2025-07-20T14:00:00Z'))).toBe(false);
    });
    it('closed on a NYSE holiday during session hours (Juneteenth 2025)', () => {
      // 2025-06-19 (Thu) is a holiday; 10:00 ET = 14:00 UTC (EDT).
      expect(isRegularSession(utc('2025-06-19T14:00:00Z'))).toBe(false);
      // sanity: the same date is flagged by isNyseHoliday too
      expect(isNyseHoliday(utc('2025-06-19T14:00:00Z'))).toBe(true);
    });
  });

  describe('overnight / midnight', () => {
    it('closed at ET midnight (handles 24→0 hour rendering)', () => {
      // 2025-07-16 04:00 UTC = 2025-07-16 00:00 ET (EDT).
      expect(isRegularSession(utc('2025-07-16T04:00:00Z'))).toBe(false);
    });
  });
});
