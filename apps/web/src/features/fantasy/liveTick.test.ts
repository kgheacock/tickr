import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Matchup,
  WeeklyScore,
  WsServerMessage,
} from '@tickr/shared-types';
import { socket } from '../../api/socket';
import { applyLiveScores, decideWinner } from './api';

// Proves the FS-09 "live tick": a `matchup.updated` push arriving on the WS
// reaches the handler useLeague registers, and the overlay flips the scoreboard
// (points + winner) without a refetch. The repo has no e2e harness (no
// Playwright), so — like logoutCache.test.ts — we drive the real primitive
// (the socket singleton) headlessly with a fake WebSocket rather than a browser.
// The Playwright e2e from the TODO is deferred (see the FS-09 ledger note).

const HOME = 'user-home';
const AWAY = 'user-away';

function weeklyScore(userId: string, totalPoints: number): WeeklyScore {
  return {
    leagueId: 'L1',
    userId,
    season: 1,
    week: 1,
    totalPoints,
    computedAt: new Date().toISOString(),
    provisional: true,
    breakdown: [],
  };
}

const baseMatchup: Matchup = {
  id: 'm1',
  leagueId: 'L1',
  season: 1,
  week: 1,
  homeUserId: HOME,
  awayUserId: AWAY,
  homePoints: null,
  awayPoints: null,
  winnerUserId: null,
  status: 'scheduled',
};

describe('applyLiveScores overlay', () => {
  it('overlays live totals and decides the winner', () => {
    const [m] = applyLiveScores(
      [baseMatchup],
      [weeklyScore(HOME, 42.5), weeklyScore(AWAY, 17.25)],
    );
    expect(m?.homePoints).toBe(42.5);
    expect(m?.awayPoints).toBe(17.25);
    expect(m?.winnerUserId).toBe(HOME);
  });

  it('leaves final matchups untouched', () => {
    const final: Matchup = {
      ...baseMatchup,
      status: 'final',
      homePoints: 10,
      awayPoints: 20,
      winnerUserId: AWAY,
    };
    const [m] = applyLiveScores([final], [weeklyScore(HOME, 99)]);
    expect(m?.homePoints).toBe(10);
    expect(m?.winnerUserId).toBe(AWAY);
  });

  it('treats a missing opponent as a bye (no winner)', () => {
    const bye: Matchup = { ...baseMatchup, awayUserId: null };
    expect(decideWinner(bye.homeUserId, bye.awayUserId, 50, null)).toBeNull();
  });
});

// --- Socket delivery: an inbound matchup.updated reaches the handler ---

const wsInstances: FakeWebSocket[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor() {
    wsInstances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

describe('socket delivers matchup.updated to useLeague-style handlers', () => {
  beforeEach(() => {
    wsInstances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'x' } });
  });

  afterEach(() => {
    socket.disconnect();
    vi.unstubAllGlobals();
  });

  it('routes a live push to a subscribed handler and overlays it', () => {
    const received: Extract<WsServerMessage, { type: 'matchup.updated' }>[] =
      [];
    // Mirrors useLeague: connect, subscribe the week's topic, handle the push.
    socket.connect();
    socket.subscribe({ kind: 'matchup', leagueId: 'L1', week: 1 });
    const off = socket.on('matchup.updated', (msg) => {
      if (msg.leagueId !== 'L1' || msg.week !== 1) return;
      received.push(msg);
    });

    const ws = wsInstances[0]!;
    ws.onopen?.(); // resubscribes the active topic over the wire

    const push: WsServerMessage = {
      type: 'matchup.updated',
      leagueId: 'L1',
      season: 1,
      week: 1,
      provisional: true,
      scores: [weeklyScore(HOME, 30), weeklyScore(AWAY, 45)],
    };
    ws.onmessage?.({ data: JSON.stringify(push) });

    expect(received).toHaveLength(1);
    const [m] = applyLiveScores([baseMatchup], received[0]!.scores);
    expect(m?.winnerUserId).toBe(AWAY); // 45 > 30, no reload required

    off();
  });

  it('ignores pushes for a different week', () => {
    const received: unknown[] = [];
    socket.connect();
    const off = socket.on('matchup.updated', (msg) => {
      if (msg.week !== 1) return;
      received.push(msg);
    });
    const ws = wsInstances[0]!;
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'matchup.updated',
        leagueId: 'L1',
        season: 1,
        week: 2,
        provisional: true,
        scores: [],
      }),
    });
    expect(received).toHaveLength(0);
    off();
  });
});
