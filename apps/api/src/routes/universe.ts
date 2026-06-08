import type { FastifyInstance } from 'fastify';
import type { UniverseResponse } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';

interface UniverseRow {
  symbol: string;
  backfilled: boolean;
  backfilled_at: Date | null;
  first_bar_at: Date | null;
  last_bar_at: Date | null;
}

/**
 * Build the corpus listing. The single corpus is the set of non-removed
 * `universe_symbol` rows (D1); each row is annotated with its backfill state
 * and the bounds of its `price_bar` coverage.
 */
export async function loadUniverse(
  backfilledOnly: boolean,
): Promise<UniverseResponse> {
  const { rows } = await pool.query<UniverseRow>(
    `SELECT us.symbol,
            us.backfilled,
            us.backfilled_at,
            MIN(pb.ts) AS first_bar_at,
            MAX(pb.ts) AS last_bar_at
       FROM universe_symbol us
       LEFT JOIN price_bar pb ON pb.symbol = us.symbol
      WHERE us.removed_at IS NULL
        AND ($1::boolean = false OR us.backfilled = true)
      GROUP BY us.symbol, us.backfilled, us.backfilled_at
      ORDER BY us.symbol`,
    [backfilledOnly],
  );

  return {
    items: rows.map((r) => ({
      symbol: r.symbol,
      backfilled: r.backfilled,
      backfilledAt: r.backfilled_at?.toISOString() ?? null,
      firstBarAt: r.first_bar_at?.toISOString() ?? null,
      lastBarAt: r.last_bar_at?.toISOString() ?? null,
    })),
  };
}

export async function registerUniverseRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{ Querystring: { backfilled?: string } }>(
    '/universe',
    { preHandler: [requireAuth] },
    async (req) => {
      const backfilledOnly = req.query.backfilled === 'true';
      return loadUniverse(backfilledOnly);
    },
  );
}
