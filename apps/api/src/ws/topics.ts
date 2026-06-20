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
    case 'draft':
      // One topic per league draft; the leagueId is part of the key so boards
      // for different leagues stay isolated.
      return `draft:${topic.leagueId}`;
    case 'scores':
      // One topic per league week of live scores (FS-05); week is in the key so
      // following one week never leaks another.
      return `scores:${topic.leagueId}:${topic.week}`;
    case 'notifications':
      // Per-user (FS-11): the gateway keys this off the connection's
      // authenticated user via notifyTopicKey, never off the topic alone (which
      // carries no user) — so this branch is unreachable by contract.
      throw new Error('notifications topic is keyed per-connection');
  }
}

/** The per-user notification topic key (FS-11) — derived from the auth'd user. */
export function notifyTopicKey(userId: string): TopicKey {
  return `notify:${userId}`;
}

/**
 * Redis pub/sub channel names. The publisher writes a complete `WsServerMessage`
 * to one of these; the subscriber routes by channel name alone. The draft
 * channel is per-league (`ws:draft:{leagueId}`).
 */
export const UNIVERSE_CHANNEL = 'ws:universe';
export const PRICES_CHANNEL = 'ws:prices';

export function draftChannel(leagueId: string): string {
  return `ws:draft:${leagueId}`;
}

export function scoresChannel(leagueId: string, week: number): string {
  return `ws:scores:${leagueId}:${week}`;
}

/** Per-user notification channel (FS-11): `ws:notify:{userId}`. */
export function notifyChannel(userId: string): string {
  return `ws:notify:${userId}`;
}

/** Pattern covering every gateway channel, for `psubscribe`. */
export const CHANNEL_PATTERN = 'ws:*';

/**
 * Reverse mapping: from a channel name, derive the topic key whose subscribers
 * should receive the message. Returns null for unrecognized channels. The
 * `ws:draft:{leagueId}` family maps to the matching per-league `draft:{id}` key.
 */
export function channelToTopicKey(channel: string): TopicKey | null {
  if (channel === UNIVERSE_CHANNEL) return 'universe';
  if (channel === PRICES_CHANNEL) return 'prices';
  if (channel.startsWith('ws:draft:')) {
    return `draft:${channel.slice('ws:draft:'.length)}`;
  }
  // ws:scores:{leagueId}:{week} → scores:{leagueId}:{week}
  if (channel.startsWith('ws:scores:')) {
    return `scores:${channel.slice('ws:scores:'.length)}`;
  }
  // ws:notify:{userId} → notify:{userId} (FS-11, per-user feed)
  if (channel.startsWith('ws:notify:')) {
    return `notify:${channel.slice('ws:notify:'.length)}`;
  }
  return null;
}
