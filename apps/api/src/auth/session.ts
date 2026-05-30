import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

const SLIDING_WINDOW_SEC = 7 * 24 * 60 * 60; // 7 days
const ABSOLUTE_MAX_SEC = 30 * 24 * 60 * 60; // 30 days
const OAUTH_ATTEMPT_TTL_SEC = 10 * 60; // 10 minutes

export interface SessionRecord {
  userId: string;
  csrfToken: string;
  createdAt: number;
  expiresAt: number;
}

export interface OAuthAttempt {
  codeVerifier: string;
  provider: 'google' | 'github';
  linkUserId?: string;
}

function sessionKey(token: string): string {
  return `session:${token}`;
}

function oauthKey(state: string): string {
  return `oauth_attempt:${state}`;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export async function createSession(
  redis: Redis,
  userId: string,
): Promise<{ token: string; record: SessionRecord }> {
  const token = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(24).toString('hex');
  const now = nowSec();
  const record: SessionRecord = {
    userId,
    csrfToken,
    createdAt: now,
    expiresAt: now + SLIDING_WINDOW_SEC,
  };
  await redis.set(
    sessionKey(token),
    JSON.stringify(record),
    'EX',
    SLIDING_WINDOW_SEC,
  );
  return { token, record };
}

export async function getSession(
  redis: Redis,
  token: string,
): Promise<SessionRecord | null> {
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  const record = JSON.parse(raw) as SessionRecord;
  if (nowSec() > record.expiresAt) {
    await redis.del(sessionKey(token));
    return null;
  }
  return record;
}

export async function touchSession(
  redis: Redis,
  token: string,
  record: SessionRecord,
): Promise<void> {
  const now = nowSec();
  const absoluteDeadline = record.createdAt + ABSOLUTE_MAX_SEC;
  const newExpiry = Math.min(now + SLIDING_WINDOW_SEC, absoluteDeadline);
  if (newExpiry <= now) {
    await redis.del(sessionKey(token));
    return;
  }
  const updated: SessionRecord = { ...record, expiresAt: newExpiry };
  await redis.set(
    sessionKey(token),
    JSON.stringify(updated),
    'EX',
    newExpiry - now,
  );
}

export async function deleteSession(
  redis: Redis,
  token: string,
): Promise<void> {
  await redis.del(sessionKey(token));
}

export async function storeOAuthAttempt(
  redis: Redis,
  state: string,
  attempt: OAuthAttempt,
): Promise<void> {
  await redis.set(
    oauthKey(state),
    JSON.stringify(attempt),
    'EX',
    OAUTH_ATTEMPT_TTL_SEC,
  );
}

export async function consumeOAuthAttempt(
  redis: Redis,
  state: string,
): Promise<OAuthAttempt | null> {
  const key = oauthKey(state);
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);
  return JSON.parse(raw) as OAuthAttempt;
}
