import type { Redis } from 'ioredis';
import type {
  WsServerMessage,
  UniverseResponse,
  PricesResponse,
  DraftPick,
} from '@tickr/shared-types';
import {
  UNIVERSE_CHANNEL,
  PRICES_CHANNEL,
  draftChannel,
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
