import type { Redis } from 'ioredis';
import { CHANNEL_PATTERN } from './topics.js';

export interface Subscriber {
  close(): Promise<void>;
}

type Handler = (channel: string, raw: string) => void;

/**
 * Subscribe to every gateway channel (`psubscribe ws:*`) on a dedicated Redis
 * connection — a connection in subscriber mode can't run other commands, so we
 * duplicate the shared client. Each api process runs one of these, which lets
 * additional api containers be added later without losing events.
 */
export function startSubscriber(redis: Redis, onMessage: Handler): Subscriber {
  const sub = redis.duplicate();

  sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
    onMessage(channel, message);
  });

  void sub.psubscribe(CHANNEL_PATTERN).catch((err: unknown) => {
    console.error(
      JSON.stringify({
        level: 'error',
        component: 'ws',
        msg: 'psubscribe failed',
        err: String(err),
      }),
    );
  });

  return {
    async close(): Promise<void> {
      try {
        await sub.punsubscribe(CHANNEL_PATTERN);
      } catch {
        /* ignore — connection may already be closing */
      }
      sub.disconnect();
    },
  };
}
