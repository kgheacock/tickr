import type { Redis } from 'ioredis';
import type { LeaderboardResponse } from '@tickr/shared-types';

const LEADERBOARD_KEY = 'leaderboard:latest';
const TAKEN_AT_KEY = 'leaderboard:taken_at';

export const TOP_N = 100;

export async function readLeaderboardCache(
  redis: Redis,
): Promise<LeaderboardResponse | null> {
  const raw = await redis.get(LEADERBOARD_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as LeaderboardResponse;
}

export async function writeLeaderboardCache(
  redis: Redis,
  payload: LeaderboardResponse,
): Promise<void> {
  await redis.set(LEADERBOARD_KEY, JSON.stringify(payload));
  await redis.set(TAKEN_AT_KEY, payload.takenAt);
}

export async function clearLeaderboardCache(redis: Redis): Promise<void> {
  await redis.del(LEADERBOARD_KEY, TAKEN_AT_KEY);
}
