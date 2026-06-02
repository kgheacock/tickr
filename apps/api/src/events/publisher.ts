import type { Redis } from 'ioredis';

export async function publish(
  redis: Redis,
  channel: string,
  payload: unknown,
): Promise<void> {
  await redis.publish(channel, JSON.stringify(payload));
}
