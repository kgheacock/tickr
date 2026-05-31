import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { runMigrations } from '../db/migrate.js';
import { requireEnv } from '../config.js';
import { registerStartRoutes } from '../routes/auth/start.js';
import { registerCallbackRoutes } from '../routes/auth/callback.js';
import { registerLogoutRoute } from '../routes/auth/logout.js';
import { registerMeRoute } from '../routes/me.js';
import { registerAdminUniverseRoutes } from '../routes/admin/universe.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = '0.0.0.0';

export async function runApi(): Promise<void> {
  await runMigrations();

  const fastify = Fastify({ logger: true });

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
      await registerMeRoute(api);
      await registerAdminUniverseRoutes(api);
    },
    { prefix: '/api/v1' },
  );

  await fastify.listen({ port: PORT, host: HOST });
  console.log(`[api] listening on http://${HOST}:${PORT}`);
}
