import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const redis = new Redis(REDIS_URL);

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: '1 minute',
    redis,
  });
  // A per-route cap that overrides the global default.
  app.get(
    '/limited',
    { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

describe('per-route rate limiting (Redis-backed)', () => {
  it('returns 429 with Retry-After once the per-route cap is exceeded', async () => {
    const app = await buildApp();

    expect(
      (await app.inject({ method: 'GET', url: '/limited' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/limited' })).statusCode,
    ).toBe(200);

    const third = await app.inject({ method: 'GET', url: '/limited' });
    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBeDefined();

    await app.close();
  });
});
