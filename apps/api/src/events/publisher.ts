import type { Redis } from 'ioredis';
import type {
  WsServerMessage,
  UniverseResponse,
  PricesResponse,
  DraftPick,
} from '@tickr/shared-types';
import type { WeeklyScore } from '@tickr/shared-types';
import {
  UNIVERSE_CHANNEL,
  PRICES_CHANNEL,
  draftChannel,
  matchupChannel,
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

/** Final pick landed; league flips to active. FS-06 listens for this. */
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
 * own Redis channel (not a WS gateway message) — FS-06 listens to settle the
 * matchup, FS-11 to build recaps. No WS consumer yet.
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
