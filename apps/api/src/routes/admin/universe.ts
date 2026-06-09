import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireAdmin, requireCsrf } from '../../auth/middleware.js';
import { upsertUniverseSchema, backfillSchema } from './schema.js';

const ADMIN_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };

export async function registerAdminUniverseRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.post(
    '/admin/universe/upsert',
    { preHandler: [requireAdmin, requireCsrf], config: ADMIN_RATE_LIMIT },
    async (req, reply) => {
      const parsed = upsertUniverseSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }

      const { symbols } = parsed.data;
      let inserted = 0;

      for (const symbol of symbols) {
        const result = await pool.query(
          `INSERT INTO universe_symbol (symbol, backfilled)
           VALUES ($1, false)
           ON CONFLICT (symbol) DO NOTHING`,
          [symbol.toUpperCase()],
        );
        if ((result.rowCount ?? 0) > 0) inserted++;
      }

      return reply.send({ inserted, total: symbols.length });
    },
  );

  fastify.post(
    '/admin/universe/backfill',
    { preHandler: [requireAdmin, requireCsrf], config: ADMIN_RATE_LIMIT },
    async (req, reply) => {
      const parsed = backfillSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }

      const { symbol } = parsed.data;
      const result = await pool.query(
        `UPDATE universe_symbol
         SET backfilled = false, backfilled_at = NULL
         WHERE symbol = $1`,
        [symbol.toUpperCase()],
      );

      if ((result.rowCount ?? 0) === 0) {
        return reply.code(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Symbol not in universe: ${symbol}`,
          },
        });
      }

      return reply.send({ symbol: symbol.toUpperCase(), backfilled: false });
    },
  );
}
