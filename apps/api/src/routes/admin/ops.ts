import type { FastifyInstance } from 'fastify';
import type { OpsResponse } from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import { getRedis } from '../../redis.js';
import { requireAdmin } from '../../auth/middleware.js';
import {
  getEodLastRun,
  massive429Count,
  jobQueueDepth,
} from '../../metrics/redis.js';
import { fantasyHealth } from '../../fantasy/admin.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `GET /admin/ops` — at-a-glance platform health (item 10). Admin-only.
 *
 * The numbers it surfaces are produced in the worker process (EOD run,
 * Massive 429s) so they come from Redis, plus a live DB count for backfill
 * progress. "Snapshot lag" from the original game design is re-targeted at the
 * daily EOD price-update cron (item 16 dropped snapshots/leaderboard).
 */
export async function registerAdminOpsRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    '/admin/ops',
    {
      preHandler: [requireAdmin],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (): Promise<OpsResponse> => {
      const redis = getRedis();

      const lastEodUpdateAt = await getEodLastRun(redis);
      const eodUpdateLagSec =
        lastEodUpdateAt === null
          ? null
          : Math.round((Date.now() - Date.parse(lastEodUpdateAt)) / 1000);

      const massive = await massive429Count(redis, DAY_MS);
      const queueDepth = await jobQueueDepth(redis);

      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM universe_symbol WHERE backfilled = false`,
      );

      // FS-12: per-fleet Fantasy Street health (leagues by status, drafts in
      // progress, last scoring run per league, stuck weeks).
      const fantasy = await fantasyHealth(pool);

      return {
        lastEodUpdateAt,
        eodUpdateLagSec,
        marketData429sLast24h: { massive },
        jobQueueDepth: queueDepth,
        backfillRemaining: rows[0]?.count ?? 0,
        fantasy,
      };
    },
  );
}
