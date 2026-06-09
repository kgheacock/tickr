import type { FastifyInstance } from 'fastify';
import { incrCounter, observe } from './registry.js';

/**
 * Records HTTP metrics on every response (item 10):
 *   - http_requests_total{route,status}
 *   - http_request_duration_ms{route}  (last-N buffer for p50/p95)
 *
 * Uses the matched route *template* (`req.routeOptions.url`) rather than the
 * concrete URL so cardinality stays bounded; unmatched requests (404s) fall
 * back to the literal url.
 */
export function registerMetrics(fastify: FastifyInstance): void {
  fastify.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? req.url;
    incrCounter('http_requests_total', { route, status: reply.statusCode });
    observe('http_request_duration_ms', reply.elapsedTime, { route });
  });
}
