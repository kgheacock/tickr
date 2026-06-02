import type { WsTopic } from '@tickr/shared-types';

/**
 * A stable string key for a subscribed topic, used as the membership key in a
 * connection's `Set<TopicKey>`. Two subscriptions to the same logical topic
 * collapse to the same key.
 */
export type TopicKey = string;

export const MAX_QUOTE_SYMBOLS = 100;

export function topicKey(topic: WsTopic): TopicKey {
  switch (topic.kind) {
    case 'portfolio':
      return `portfolio:${topic.portfolioId}`;
    case 'leaderboard':
      return 'leaderboard';
    case 'quotes':
      // Symbols are tracked per-connection separately; the topic itself is
      // singular so re-subscribing replaces the symbol set.
      return 'quotes';
  }
}

/**
 * Redis pub/sub channel names. The publisher writes a complete `WsServerMessage`
 * to one of these; the subscriber routes by channel name alone.
 */
export const LEADERBOARD_CHANNEL = 'ws:leaderboard';
export const QUOTES_CHANNEL = 'ws:quotes';

export function portfolioChannel(portfolioId: string): string {
  return `ws:portfolio:${portfolioId}`;
}

/** Pattern covering every gateway channel, for `psubscribe`. */
export const CHANNEL_PATTERN = 'ws:*';

/**
 * Reverse mapping: from a channel name, derive the topic key whose subscribers
 * should receive the message. Returns null for unrecognized channels.
 */
export function channelToTopicKey(channel: string): TopicKey | null {
  if (channel === LEADERBOARD_CHANNEL) return 'leaderboard';
  if (channel === QUOTES_CHANNEL) return 'quotes';
  if (channel.startsWith('ws:portfolio:')) {
    return `portfolio:${channel.slice('ws:portfolio:'.length)}`;
  }
  return null;
}
