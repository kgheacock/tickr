import type { FastifyInstance } from 'fastify';
import type { OpsResponse } from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import { getRedis } from '../../redis.js';
import { requireAdmin } from '../../auth/middleware.js';
import { isRegularSession, mostRecentClose } from '../../market/holidays.js';
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

      // Worst price-bar staleness in the DB. Fresh bars are expected up to ~now
      // during a live session (the intraday sweep runs every 5 min, see
      // scheduler.ts) but only up to the most recent NYSE close off-hours — so the
      // reference is min(now, last close), which keeps weekends/holidays from
      // reading as lag.
      const now = new Date();
      const referenceTs = isRegularSession(now) ? now : mostRecentClose(now);

      // The playable symbol whose latest bar is oldest. The predicate MUST mirror
      // runIntradayUpdate's selection (intraday-update.ts) — those are the symbols
      // we keep fresh; removed/incomplete ones are intentionally stale and would
      // otherwise masquerade as the worst lag forever. The lateral per-symbol
      // max(ts) hits the (symbol, ts) PK index instead of scanning the hypertable.
      const { rows: lagRows } = await pool.query<{
        symbol: string;
        latest: Date;
      }>(
        `SELECT u.symbol, b.latest
           FROM universe_symbol u
           CROSS JOIN LATERAL (
             SELECT max(ts) AS latest FROM price_bar WHERE symbol = u.symbol
           ) b
          WHERE u.backfilled = true
            AND u.removed_at IS NULL
            AND u.data_status IS DISTINCT FROM 'incomplete'
            AND b.latest IS NOT NULL
          ORDER BY b.latest ASC
          LIMIT 1`,
        // A backfilled symbol with zero bars (b.latest IS NULL) is the data
        // audit's job (Finding 4), not a lag we can measure from a missing bar.
      );

      const worst = lagRows[0];
      const worstLag = worst
        ? {
            symbol: worst.symbol,
            latestBarAt: worst.latest.toISOString(),
            lagSec: Math.max(
              0,
              Math.round(
                (referenceTs.getTime() - worst.latest.getTime()) / 1000,
              ),
            ),
          }
        : null;

      return {
        lastEodUpdateAt,
        eodUpdateLagSec,
        marketData429sLast24h: { massive },
        jobQueueDepth: queueDepth,
        backfillRemaining: rows[0]?.count ?? 0,
        fantasy,
        worstLag,
      };
    },
  );
}
