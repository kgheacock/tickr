import type { Redis } from 'ioredis';
import type {
  WsServerMessage,
  UniverseResponse,
  PricesResponse,
  DraftPick,
} from '@tickr/shared-types';
import type { WeeklyScore, Notification } from '@tickr/shared-types';
import {
  UNIVERSE_CHANNEL,
  PRICES_CHANNEL,
  draftChannel,
  matchupChannel,
  notifyChannel,
} from '../ws/topics.js';

/**
 * The single place the rest of the codebase pushes realtime events from. Each
 * helper writes a complete `WsServerMessage` to a per-topic Redis channel; the
 * WS gateway's subscriber (see ws/subscriber.ts) fans it out to connections.
 *
 * Callers must invoke these only after the originating DB writes have
 * committed — never mid-transaction.
 */

async function publishMessage(
  redis: Redis,
  channel: string,
  message: WsServerMessage,
): Promise<void> {
  await redis.publish(channel, JSON.stringify(message));
}

/** Corpus membership / backfill state changed. */
export async function publishUniverseUpdated(
  redis: Redis,
  data: UniverseResponse,
): Promise<void> {
  await publishMessage(redis, UNIVERSE_CHANNEL, {
    type: 'universe.updated',
    data,
  });
}

/** New bars were appended for the named symbols. */
export async function publishPricesUpdated(
  redis: Redis,
  asOf: string,
  series: PricesResponse['series'],
): Promise<void> {
  await publishMessage(redis, PRICES_CHANNEL, {
    type: 'prices.updated',
    asOf,
    series,
  });
}

// --- Live draft (item 03) ---

/** A pick landed; carries the new on-the-clock state so boards stay in sync. */
export async function publishDraftPick(
  redis: Redis,
  leagueId: string,
  pick: DraftPick,
  currentOverallPick: number,
  onClockUserId: string | null,
  deadline: string | null,
): Promise<void> {
  await publishMessage(redis, draftChannel(leagueId), {
    type: 'draft.pick',
    leagueId,
    pick,
    currentOverallPick,
    onClockUserId,
    deadline,
  });
}

/** The clock advanced to a new manager (also emitted on draft start). */
export async function publishDraftOnClock(
  redis: Redis,
  leagueId: string,
  overallPick: number,
  userId: string,
  deadline: string,
): Promise<void> {
  await publishMessage(redis, draftChannel(leagueId), {
    type: 'draft.onClock',
    leagueId,
    overallPick,
    userId,
    deadline,
  });
}

/**
 * Final pick landed; league flips to active. A WS message for live boards —
 * FS-06 schedule generation is driven in-process from draftClock (not off this
 * echo), so a dropped message can't leave a league unscheduled.
 */
export async function publishDraftComplete(
  redis: Redis,
  leagueId: string,
  draftId: string,
): Promise<void> {
  await publishMessage(redis, draftChannel(leagueId), {
    type: 'draft.complete',
    leagueId,
    draftId,
  });
}

// --- Rosters & weekly lineups (item 04) ---

/**
 * A manager's weekly lineup was frozen at market open. A plain domain event on
 * its own Redis channel (not a WS gateway message) — FS-09/11 will subscribe to
 * surface "lineup locked" follows and recaps; until then it has no consumer.
 */
export const LINEUP_LOCKED_CHANNEL = 'fs:lineup:locked';

export interface LineupLockedEvent {
  type: 'lineup.locked';
  leagueId: string;
  userId: string;
  season: number;
  week: number;
  autoFilled: boolean;
}

export async function publishLineupLocked(
  redis: Redis,
  event: Omit<LineupLockedEvent, 'type'>,
): Promise<void> {
  await redis.publish(
    LINEUP_LOCKED_CHANNEL,
    JSON.stringify({
      type: 'lineup.locked',
      ...event,
    } satisfies LineupLockedEvent),
  );
}

// --- Scoring & shorting (item 05) ---

/**
 * A league's week was settled at the Friday close. A plain domain event on its
 * own Redis channel (not a WS gateway message) — FS-06 settles matchups
 * in-process in the scoring job (not off this echo), and FS-11 will build recaps
 * from it. No consumer yet.
 */
export const SCORE_UPDATED_CHANNEL = 'fs:score:updated';

export interface ScoreUpdatedEvent {
  type: 'score.updated';
  leagueId: string;
  season: number;
  week: number;
}

export async function publishScoreUpdated(
  redis: Redis,
  event: Omit<ScoreUpdatedEvent, 'type'>,
): Promise<void> {
  await redis.publish(
    SCORE_UPDATED_CHANNEL,
    JSON.stringify({
      type: 'score.updated',
      ...event,
    } satisfies ScoreUpdatedEvent),
  );
}

// --- Waivers & trades (item 07) ---

/**
 * A league's waiver run resolved its queued claims. A plain domain event on its
 * own Redis channel (not a WS gateway message), mirroring score.updated — the
 * dashboard (FS-09) and recaps (FS-11) will surface waiver activity off it; no
 * consumer yet.
 */
export const WAIVER_PROCESSED_CHANNEL = 'fs:waiver:processed';

export interface WaiverProcessedEvent {
  type: 'waiver.processed';
  leagueId: string;
  season: number;
  /** Claims awarded this run (the rest were marked lost/invalid). */
  awarded: number;
}

export async function publishWaiverProcessed(
  redis: Redis,
  event: Omit<WaiverProcessedEvent, 'type'>,
): Promise<void> {
  await redis.publish(
    WAIVER_PROCESSED_CHANNEL,
    JSON.stringify({
      type: 'waiver.processed',
      ...event,
    } satisfies WaiverProcessedEvent),
  );
}

/**
 * A trade was accepted and ownership swapped. A plain domain event on its own
 * Redis channel (not a WS gateway message); FS-09/11 will follow it for trade
 * notifications and recaps. No consumer yet.
 */
export const TRADE_ACCEPTED_CHANNEL = 'fs:trade:accepted';

export interface TradeAcceptedEvent {
  type: 'trade.accepted';
  leagueId: string;
  tradeId: string;
  proposerUserId: string;
  targetUserId: string;
}

export async function publishTradeAccepted(
  redis: Redis,
  event: Omit<TradeAcceptedEvent, 'type'>,
): Promise<void> {
  await redis.publish(
    TRADE_ACCEPTED_CHANNEL,
    JSON.stringify({
      type: 'trade.accepted',
      ...event,
    } satisfies TradeAcceptedEvent),
  );
}

// --- Season & playoffs (item 08) ---

/**
 * A league's season ended and a champion was crowned (the final playoff matchup
 * settled). A plain domain event on its own Redis channel (not a WS gateway
 * message), mirroring score.updated — the dashboard (FS-09) and recaps (FS-11)
 * will surface the champion off it; no consumer yet.
 */
export const SEASON_CHAMPION_CHANNEL = 'fs:season:champion';

export interface SeasonChampionEvent {
  type: 'season.champion';
  leagueId: string;
  season: number;
  championUserId: string;
}

export async function publishSeasonChampion(
  redis: Redis,
  event: Omit<SeasonChampionEvent, 'type'>,
): Promise<void> {
  await redis.publish(
    SEASON_CHAMPION_CHANNEL,
    JSON.stringify({
      type: 'season.champion',
      ...event,
    } satisfies SeasonChampionEvent),
  );
}

/**
 * Live per-manager scores for a league week — provisional (in-week) or final
 * (Friday-settled). A WS gateway message on the per-(league, week) matchup
 * channel; the dashboard (FS-09) follows it for a live scoreboard.
 */
export async function publishMatchupUpdated(
  redis: Redis,
  leagueId: string,
  season: number,
  week: number,
  scores: WeeklyScore[],
  provisional: boolean,
): Promise<void> {
  await publishMessage(redis, matchupChannel(leagueId, week), {
    type: 'matchup.updated',
    leagueId,
    season,
    week,
    provisional,
    scores,
  });
}

// --- Reminders & recaps (item 11) ---

/**
 * Push a freshly-written notification to its owner's live feed (FS-09). A WS
 * gateway message on the per-user `ws:notify:{userId}` channel — the gateway
 * keys the subscription off the authenticated connection, so this only ever
 * reaches that one manager. Best-effort: the durable row is already committed,
 * so a dropped push just means the feed updates on the next fetch.
 */
export async function publishNotification(
  redis: Redis,
  userId: string,
  notification: Notification,
): Promise<void> {
  await publishMessage(redis, notifyChannel(userId), {
    type: 'notification',
    notification,
  });
}

/**
 * A league's weekly recaps were generated after the Friday settle. A plain
 * domain event on its own Redis channel (not a WS gateway message), mirroring
 * score.updated — the individual recap rows are pushed per-user via
 * publishNotification; this is the league-level signal. No consumer yet.
 */
export const RECAP_READY_CHANNEL = 'fs:recap:ready';

export interface RecapReadyEvent {
  type: 'recap.ready';
  leagueId: string;
  season: number;
  week: number;
}

export async function publishRecapReady(
  redis: Redis,
  event: Omit<RecapReadyEvent, 'type'>,
): Promise<void> {
  await redis.publish(
    RECAP_READY_CHANNEL,
    JSON.stringify({
      type: 'recap.ready',
      ...event,
    } satisfies RecapReadyEvent),
  );
}
