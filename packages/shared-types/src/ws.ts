import type { UniverseResponse, PricesResponse, ApiError } from './index.js';
import type { DraftPick, WeeklyScore, Notification } from './fantasy.js';

export type WsTopic =
  | { kind: 'universe' } // corpus membership / backfill state changes
  | { kind: 'prices'; symbols: string[] } // new bars for the named symbols
  | { kind: 'draft'; leagueId: string } // live draft board + clock for a league
  | { kind: 'matchup'; leagueId: string; week: number } // live weekly scores
  // The signed-in user's own notification feed (FS-11). No params — the gateway
  // keys it to the connection's authenticated user, so one manager can never
  // follow another's feed; an unsubscribe targets the same implicit topic.
  | { kind: 'notifications' };

export type WsClientMessage =
  | { type: 'subscribe'; topic: WsTopic }
  | { type: 'unsubscribe'; topic: WsTopic };

export type WsServerMessage =
  | { type: 'universe.updated'; data: UniverseResponse }
  | { type: 'prices.updated'; asOf: string; series: PricesResponse['series'] }
  // --- Live draft (item 03) ---
  // A pick landed; carries the new on-the-clock state so boards stay in sync.
  | {
      type: 'draft.pick';
      leagueId: string;
      pick: DraftPick;
      currentOverallPick: number;
      onClockUserId: string | null;
      deadline: string | null;
    }
  // The clock advanced to a new manager (also emitted on draft start).
  | {
      type: 'draft.onClock';
      leagueId: string;
      overallPick: number;
      userId: string;
      deadline: string;
    }
  // Final pick landed; league flips to active. FS-06 listens for this.
  | { type: 'draft.complete'; leagueId: string; draftId: string }
  // --- Live weekly scoring (item 05) ---
  // Provisional (in-week) or final (Friday-settled) per-manager scores for a
  // league week, pushed as the week's prices move. `provisional` flags whether
  // the totals are best-effort (latest close) or the settled Friday result.
  | {
      type: 'matchup.updated';
      leagueId: string;
      season: number;
      week: number;
      provisional: boolean;
      scores: WeeklyScore[];
    }
  // --- Reminders & recaps (item 11) ---
  // A new in-app notification for the connected manager (lineup/draft reminder
  // or weekly recap), pushed the moment it is written so the FS-09 feed updates
  // live without a refetch.
  | { type: 'notification'; notification: Notification }
  | { type: 'error'; error: ApiError['error'] };
