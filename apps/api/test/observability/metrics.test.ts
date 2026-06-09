import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { registerMetrics } from '../../src/metrics/middleware.js';
import {
  getCounter,
  getObservationCount,
  snapshot,
  resetMetrics,
  incrCounter,
  observe,
} from '../../src/metrics/registry.js';

describe('metrics registry', () => {
  beforeEach(() => resetMetrics());

  it('counts with sorted, label-keyed series', () => {
    incrCounter('c', { b: 2, a: 1 });
    incrCounter('c', { a: 1, b: 2 });
    expect(getCounter('c', { a: 1, b: 2 })).toBe(2);
  });

  it('computes p50/p95 from the observation buffer', () => {
    for (let i = 1; i <= 100; i++) observe('d', i);
    const { durations } = snapshot();
    const stats = durations['d']!;
    expect(stats.count).toBe(100);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
  });
});

describe('metrics middleware', () => {
  beforeEach(() => resetMetrics());

  it('records http_requests_total and http_request_duration_ms per route', async () => {
    const app = Fastify({ logger: false });
    registerMetrics(app);
    app.get('/ping', async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: 'GET', url: '/ping' });
    await app.inject({ method: 'GET', url: '/ping' });

    expect(
      getCounter('http_requests_total', { route: '/ping', status: 200 }),
    ).toBe(2);
    expect(
      getObservationCount('http_request_duration_ms', { route: '/ping' }),
    ).toBe(2);

    await app.close();
  });
});
