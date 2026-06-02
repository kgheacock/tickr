import type { Redis } from 'ioredis';
import type {
  WsServerMessage,
  PortfolioView,
  Order,
  Fill,
  LeaderboardResponse,
  QuotesResponse,
} from '@tickr/shared-types';
import {
  LEADERBOARD_CHANNEL,
  QUOTES_CHANNEL,
  portfolioChannel,
} from '../ws/topics.js';

/**
 * The single place the rest of the codebase pushes realtime events from. Each
 * helper writes a complete `WsServerMessage` to a per-topic Redis channel; the
 * WS gateway's subscriber (see ws/subscriber.ts) fans it out to connections.
 *
 * Callers must invoke these only after the originating DB transaction has
 * committed — never inside a `BEGIN/COMMIT` block.
 */

async function publishMessage(
  redis: Redis,
  channel: string,
  message: WsServerMessage,
): Promise<void> {
  await redis.publish(channel, JSON.stringify(message));
}

export async function publishOrderFilled(
  redis: Redis,
  portfolioId: string,
  order: Order,
  fill: Fill,
): Promise<void> {
  await publishMessage(redis, portfolioChannel(portfolioId), {
    type: 'order.filled',
    portfolioId,
    order,
    fill,
  });
}

export async function publishPortfolioUpdated(
  redis: Redis,
  portfolioId: string,
  view: PortfolioView,
): Promise<void> {
  await publishMessage(redis, portfolioChannel(portfolioId), {
    type: 'portfolio.updated',
    portfolioId,
    view,
  });
}

export async function publishLeaderboardUpdated(
  redis: Redis,
  data: LeaderboardResponse,
): Promise<void> {
  await publishMessage(redis, LEADERBOARD_CHANNEL, {
    type: 'leaderboard.updated',
    data,
  });
}

export async function publishQuotesUpdated(
  redis: Redis,
  asOf: string,
  quotes: QuotesResponse['quotes'],
): Promise<void> {
  await publishMessage(redis, QUOTES_CHANNEL, {
    type: 'quotes.updated',
    asOf,
    quotes,
  });
}
