import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { runMigrations } from '../db/migrate.js';
import { requireEnv } from '../config.js';
import { registerStartRoutes } from '../routes/auth/start.js';
import { registerCallbackRoutes } from '../routes/auth/callback.js';
import { registerLogoutRoute } from '../routes/auth/logout.js';
import { registerDevLoginRoute } from '../routes/auth/dev-login.js';
import { registerMeRoute } from '../routes/me.js';
import { registerAdminUniverseRoutes } from '../routes/admin/universe.js';
import { registerUniverseRoute } from '../routes/universe.js';
import { registerPricesRoute } from '../routes/prices.js';
import { registerEvaluateRoute } from '../routes/evaluate.js';
import { registerEtfsRoutes } from '../routes/etfs.js';
import { registerStrategyRoutes } from '../routes/strategies.js';
import { registerAdminOpsRoute } from '../routes/admin/ops.js';
import { registerAdminLogsRoutes } from '../routes/admin/logs.js';
import { getRedis } from '../redis.js';
import { attachWsGateway } from '../ws/server.js';
import {
  baseLoggerOptions,
  genRequestId,
  getLogDestination,
} from '../log/logger.js';
import { registerMetrics } from '../metrics/middleware.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = '0.0.0.0';

export async function runApi(): Promise<void> {
  await runMigrations();

  const fastify = Fastify({
    // Same options as the worker's rootLogger, but routed through the shared
    // stdout+Redis destination so api request logs reach the admin viewer too.
    logger: { ...baseLoggerOptions, stream: getLogDestination() },
    genReqId: genRequestId,
    requestIdLogLabel: 'request_id',
  });

  registerMetrics(fastify);

  // Redis-backed so per-IP limits hold across api instances. Default per-IP
  // cap is 60 req/min; per-route caps (auth start, admin) tighten this.
  await fastify.register(rateLimit, {
    global: true,
    max: 60,
    timeWindow: '1 minute',
    redis: getRedis(),
  });

  await fastify.register(cookie, {
    secret: requireEnv('SESSION_SIGNING_KEY'),
    parseOptions: {},
  });

  // All API routes under /api/v1
  await fastify.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));

      await registerStartRoutes(api);
      await registerCallbackRoutes(api);
      await registerLogoutRoute(api);

      // DEV-ONLY auth bypass, gated three ways: (1) defaults closed — needs an
      // explicit opt-in, (2) refuses to run under NODE_ENV=production, and
      // (3) scripts/deploy.sh refuses to deploy if TICKR_DEV_AUTH is set in the
      // prod secrets. The dev compose overlay sets both vars; prod never does.
      if (
        process.env['TICKR_DEV_AUTH'] === '1' &&
        process.env['NODE_ENV'] !== 'production'
      ) {
        api.log.warn(
          'TICKR_DEV_AUTH=1 — registering POST /auth/dev-login backdoor. NEVER enable this in production.',
        );
        await registerDevLoginRoute(api);
      }
      await registerMeRoute(api);
      await registerAdminUniverseRoutes(api);
      await registerUniverseRoute(api);
      await registerPricesRoute(api);
      await registerEvaluateRoute(api);
      await registerEtfsRoutes(api);
      await registerStrategyRoutes(api);
      await registerAdminOpsRoute(api);
      await registerAdminLogsRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  await fastify.listen({ port: PORT, host: HOST });

  // Mount the WebSocket gateway on the same HTTP server (item 09). Caddy
  // upgrades /ws through the proxy.
  attachWsGateway(fastify.server, getRedis());

  console.log(`[api] listening on http://${HOST}:${PORT}`);
}
