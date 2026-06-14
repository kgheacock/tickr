import { describe, it, expect } from 'vitest';
import {
  isRegularSession,
  isNyseHoliday,
  nyseRegularCloseAnchor,
  mostRecentClose,
} from '../../src/market/holidays.js';

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

describe('nyseRegularCloseAnchor', () => {
  // The anchor marks the instant just *before* 16:00 ET, so a `ts <= anchor`
  // lookup lands on the last regular-session bar (15:45 ET) and excludes the
  // first after-hours bar (ts = 16:00 ET).
  it('EDT: 16:00 ET close is 20:00 UTC; anchor is 1ms before', () => {
    // Fri 2025-07-18, noon ET = 16:00 UTC (EDT).
    const anchor = nyseRegularCloseAnchor(utc('2025-07-18T16:00:00Z'));
    expect(anchor.toISOString()).toBe('2025-07-18T19:59:59.999Z');
    // +1ms lands exactly on the 16:00 ET close → excluded by `ts <= anchor`.
    expect(new Date(anchor.getTime() + 1).toISOString()).toBe(
      '2025-07-18T20:00:00.000Z',
    );
  });

  it('EST: 16:00 ET close is 21:00 UTC; anchor is 1ms before', () => {
    // Fri 2025-01-17, noon ET = 17:00 UTC (EST).
    const anchor = nyseRegularCloseAnchor(utc('2025-01-17T17:00:00Z'));
    expect(anchor.toISOString()).toBe('2025-01-17T20:59:59.999Z');
  });

  it('resolves the close on the ET calendar date, not the UTC date', () => {
    // 2025-07-18T02:00:00Z is still 2025-07-17 22:00 ET → anchor on the 17th.
    const anchor = nyseRegularCloseAnchor(utc('2025-07-18T02:00:00Z'));
    expect(anchor.toISOString()).toBe('2025-07-17T19:59:59.999Z');
  });

  it('a DST-transition week keeps both endpoints at 16:00 ET (not 7×24h apart)', () => {
    // US DST began Sun 2025-03-09. Fri 2025-03-14 is EDT (−4); the prior Friday
    // 2025-03-07 is EST (−5). Anchoring each zone-aware yields a 16:00-ET-to-
    // 16:00-ET gap of 7d − 1h, which a fixed weekEnd−7d would get wrong.
    const thisFri = nyseRegularCloseAnchor(utc('2025-03-14T16:00:00Z'));
    const priorFri = nyseRegularCloseAnchor(utc('2025-03-07T16:00:00Z'));
    expect(thisFri.toISOString()).toBe('2025-03-14T19:59:59.999Z'); // EDT 20:00Z
    expect(priorFri.toISOString()).toBe('2025-03-07T20:59:59.999Z'); // EST 21:00Z
    const gapHours = (thisFri.getTime() - priorFri.getTime()) / 3_600_000;
    expect(gapHours).toBe(7 * 24 - 1);
  });
});

describe('mostRecentClose', () => {
  // EDT close = 20:00 UTC (16:00 - 4h); EST close = 21:00 UTC (16:00 - 5h).
  it('returns the previous session close mid-session (cap at last close)', () => {
    // Wed 2025-07-16 11:00 ET — today's 16:00 hasn't happened, so the last
    // completed close is Tue 2025-07-15 16:00 EDT = 20:00 UTC.
    expect(mostRecentClose(utc('2025-07-16T15:00:00Z')).toISOString()).toBe(
      '2025-07-15T20:00:00.000Z',
    );
  });

  it('returns today’s close once it has passed (EDT)', () => {
    // Wed 2025-07-16 18:00 ET (22:00 UTC) — after today's close.
    expect(mostRecentClose(utc('2025-07-16T22:00:00Z')).toISOString()).toBe(
      '2025-07-16T20:00:00.000Z',
    );
  });

  it('returns today’s close once it has passed (EST, 21:00 UTC)', () => {
    // Wed 2025-01-15 18:00 ET (23:00 UTC).
    expect(mostRecentClose(utc('2025-01-15T23:00:00Z')).toISOString()).toBe(
      '2025-01-15T21:00:00.000Z',
    );
  });

  it('walks back over a weekend to Friday’s close', () => {
    // Sat 2025-07-19 12:00 ET → Fri 2025-07-18 16:00 EDT = 20:00 UTC.
    expect(mostRecentClose(utc('2025-07-19T16:00:00Z')).toISOString()).toBe(
      '2025-07-18T20:00:00.000Z',
    );
  });

  it('walks back over a holiday (Juneteenth 2025, Thu) to Wednesday’s close', () => {
    // Thu 2025-06-19 10:00 ET is a holiday → Wed 2025-06-18 16:00 EDT = 20:00 UTC.
    expect(mostRecentClose(utc('2025-06-19T14:00:00Z')).toISOString()).toBe(
      '2025-06-18T20:00:00.000Z',
    );
  });

  it('exactly at the close counts today (16:00 ET inclusive)', () => {
    // Wed 2025-07-16 16:00 ET = 20:00 UTC.
    expect(mostRecentClose(utc('2025-07-16T20:00:00Z')).toISOString()).toBe(
      '2025-07-16T20:00:00.000Z',
    );
  });
});
