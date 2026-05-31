import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Redis } from 'ioredis';
import {
  createSession,
  getSession,
  touchSession,
  deleteSession,
  storeOAuthAttempt,
  consumeOAuthAttempt,
} from '../../src/auth/session.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

let redis: Redis;

beforeEach(() => {
  redis = new Redis(REDIS_URL);
});

afterEach(async () => {
  await redis.quit();
});

describe('session lifecycle', () => {
  it('creates and retrieves a session', async () => {
    const userId = 'user-abc';
    const { token, record } = await createSession(redis, userId);
    expect(token).toHaveLength(64); // 32 bytes hex
    expect(record.userId).toBe(userId);
    expect(record.csrfToken).toBeTruthy();
    expect(record.createdAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(record.expiresAt).toBeGreaterThan(record.createdAt);

    const retrieved = await getSession(redis, token);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.userId).toBe(userId);
    expect(retrieved!.csrfToken).toBe(record.csrfToken);
  });

  it('returns null for unknown token', async () => {
    const result = await getSession(redis, 'nonexistent-token');
    expect(result).toBeNull();
  });

  it('deletes a session', async () => {
    const { token } = await createSession(redis, 'user-del');
    await deleteSession(redis, token);
    const result = await getSession(redis, token);
    expect(result).toBeNull();
  });

  it('rejects an already-expired session', async () => {
    const userId = 'user-expired';
    const { token } = await createSession(redis, userId);
    // Manually write a session that expires in the past
    await redis.set(
      `session:${token}`,
      JSON.stringify({
        userId,
        csrfToken: 'x',
        createdAt: 1000,
        expiresAt: 1001,
      }),
      'EX',
      600,
    );
    const result = await getSession(redis, token);
    expect(result).toBeNull();
  });

  it('touchSession extends the sliding window', async () => {
    const { token, record } = await createSession(redis, 'user-touch');
    const originalExpiry = record.expiresAt;
    // Simulate some time passing by manipulating expiresAt
    const staleRecord = { ...record, expiresAt: record.expiresAt - 100 };
    await touchSession(redis, token, staleRecord);
    const updated = await getSession(redis, token);
    expect(updated).not.toBeNull();
    expect(updated!.expiresAt).toBeGreaterThanOrEqual(originalExpiry - 100);
  });

  it('getSession rejects when absolute cap is exceeded even if sliding window is valid', async () => {
    const userId = 'user-cap-get';
    const { token } = await createSession(redis, userId);
    const now = Math.floor(Date.now() / 1000);
    // 31-day-old session whose sliding window hasn't expired yet
    await redis.set(
      `session:${token}`,
      JSON.stringify({
        userId,
        csrfToken: 'abc',
        createdAt: now - 31 * 24 * 60 * 60,
        expiresAt: now + 60,
      }),
      'EX',
      60,
    );
    const result = await getSession(redis, token);
    expect(result).toBeNull();
  });

  it('touchSession rejects when absolute cap is exceeded', async () => {
    const userId = 'user-cap';
    const { token } = await createSession(redis, userId);
    const now = Math.floor(Date.now() / 1000);
    // Simulate a 31-day-old session (past the 30-day absolute cap)
    const oldRecord = {
      userId,
      csrfToken: 'abc',
      createdAt: now - 31 * 24 * 60 * 60,
      expiresAt: now + 60, // would still be valid by sliding window
    };
    await redis.set(`session:${token}`, JSON.stringify(oldRecord), 'EX', 60);
    await touchSession(redis, token, oldRecord);
    const result = await getSession(redis, token);
    expect(result).toBeNull();
  });
});

describe('OAuth attempt store', () => {
  it('stores and consumes an attempt (single-use)', async () => {
    const state = 'test-state-123';
    await storeOAuthAttempt(redis, state, {
      codeVerifier: 'cv',
      provider: 'google',
    });

    const attempt = await consumeOAuthAttempt(redis, state);
    expect(attempt).not.toBeNull();
    expect(attempt!.codeVerifier).toBe('cv');
    expect(attempt!.provider).toBe('google');

    // Second consume returns null (single-use)
    const second = await consumeOAuthAttempt(redis, state);
    expect(second).toBeNull();
  });

  it('stores linkUserId for account-linking flows', async () => {
    await storeOAuthAttempt(redis, 'link-state', {
      codeVerifier: 'cv2',
      provider: 'github',
      linkUserId: 'user-xyz',
    });
    const attempt = await consumeOAuthAttempt(redis, 'link-state');
    expect(attempt!.linkUserId).toBe('user-xyz');
  });
});
