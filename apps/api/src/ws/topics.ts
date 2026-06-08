import type { WsTopic } from '@tickr/shared-types';

/**
 * A stable string key for a subscribed topic, used as the membership key in a
 * connection's `Set<TopicKey>`. Two subscriptions to the same logical topic
 * collapse to the same key.
 */
export type TopicKey = string;

/** Cap on the symbols a single `prices` subscription may name. */
export const MAX_PRICE_SYMBOLS = 100;

export function topicKey(topic: WsTopic): TopicKey {
  switch (topic.kind) {
    case 'universe':
      return 'universe';
    case 'prices':
      // Symbols are tracked per-connection separately; the topic itself is
      // singular so re-subscribing replaces the symbol set.
      return 'prices';
  }
}

/**
 * Redis pub/sub channel names. The publisher writes a complete `WsServerMessage`
 * to one of these; the subscriber routes by channel name alone.
 */
export const UNIVERSE_CHANNEL = 'ws:universe';
export const PRICES_CHANNEL = 'ws:prices';

/** Pattern covering every gateway channel, for `psubscribe`. */
export const CHANNEL_PATTERN = 'ws:*';

/**
 * Reverse mapping: from a channel name, derive the topic key whose subscribers
 * should receive the message. Returns null for unrecognized channels.
 */
export function channelToTopicKey(channel: string): TopicKey | null {
  if (channel === UNIVERSE_CHANNEL) return 'universe';
  if (channel === PRICES_CHANNEL) return 'prices';
  return null;
}
