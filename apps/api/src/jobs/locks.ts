import type { Redis } from 'ioredis';

// Lua script: DEL key only if its current value matches the owner token.
// Prevents a delayed process from releasing another process's lock.
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

/**
 * Try to acquire an exclusive lock. Returns the owner token if acquired,
 * null if the lock is already held.
 */
export async function tryAcquireLock(
  redis: Redis,
  key: string,
  ttlMs: number,
): Promise<string | null> {
  const owner = `${process.pid}-${Date.now()}-${Math.random()}`;
  const result = await redis.set(key, owner, 'PX', ttlMs, 'NX');
  return result === 'OK' ? owner : null;
}

/** Release a lock only if this process still owns it. */
export async function releaseLock(
  redis: Redis,
  key: string,
  owner: string,
): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, key, owner);
}

/** True if the lock key currently exists (held by some owner). */
export async function isLockHeld(redis: Redis, key: string): Promise<boolean> {
  return (await redis.exists(key)) === 1;
}
