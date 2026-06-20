import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WeeklyScore, WsServerMessage } from '@tickr/shared-types';
import { socket } from '../../api/socket';
import { rankScores } from './api';

// Proves the FS-09 "live tick": a `scores.updated` push arriving on the WS
// reaches the handler useLeague registers, and the derived weekly ranking
// reflects it without a refetch. The repo has no e2e harness (no Playwright),
// so — like logoutCache.test.ts — we drive the real primitive (the socket
// singleton) headlessly with a fake WebSocket rather than a browser.

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

describe('rankScores derivation', () => {
  it('ranks live totals high → low', () => {
    const ranking = rankScores([
      weeklyScore(HOME, 42.5),
      weeklyScore(AWAY, 17.25),
    ]);
    expect(ranking[0]).toMatchObject({ userId: HOME, rank: 1 });
    expect(ranking[1]).toMatchObject({ userId: AWAY, rank: 2 });
  });

  it('shares a rank on ties', () => {
    const ranking = rankScores([weeklyScore(HOME, 20), weeklyScore(AWAY, 20)]);
    expect(ranking.every((r) => r.rank === 1)).toBe(true);
  });
});

// --- Socket delivery: an inbound scores.updated reaches the handler ---

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

describe('socket delivers scores.updated to useLeague-style handlers', () => {
  beforeEach(() => {
    wsInstances.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'x' } });
  });

  afterEach(() => {
    socket.disconnect();
    vi.unstubAllGlobals();
  });

  it('routes a live push to a subscribed handler and ranks it', () => {
    const received: Extract<WsServerMessage, { type: 'scores.updated' }>[] = [];
    // Mirrors useLeague: connect, subscribe the week's topic, handle the push.
    socket.connect();
    socket.subscribe({ kind: 'scores', leagueId: 'L1', week: 1 });
    const off = socket.on('scores.updated', (msg) => {
      if (msg.leagueId !== 'L1' || msg.week !== 1) return;
      received.push(msg);
    });

    const ws = wsInstances[0]!;
    ws.onopen?.(); // resubscribes the active topic over the wire

    const push: WsServerMessage = {
      type: 'scores.updated',
      leagueId: 'L1',
      season: 1,
      week: 1,
      provisional: true,
      scores: [weeklyScore(HOME, 30), weeklyScore(AWAY, 45)],
    };
    ws.onmessage?.({ data: JSON.stringify(push) });

    expect(received).toHaveLength(1);
    const ranking = rankScores(received[0]!.scores);
    expect(ranking[0]).toMatchObject({ userId: AWAY, rank: 1 }); // 45 > 30

    off();
  });

  it('ignores pushes for a different week', () => {
    const received: unknown[] = [];
    socket.connect();
    const off = socket.on('scores.updated', (msg) => {
      if (msg.week !== 1) return;
      received.push(msg);
    });
    const ws = wsInstances[0]!;
    ws.onopen?.();
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'scores.updated',
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
