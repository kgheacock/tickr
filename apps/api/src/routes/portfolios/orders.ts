import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { executeTrade, TradeRejectionError } from '../../trading/execute.js';
import { createOrderSchema, paginationSchema } from './schema.js';
import { requirePortfolioAccess, requirePortfolioWrite } from './middleware.js';
import { getRedis } from '../../redis.js';
import { getPortfolioView } from './view-query.js';
import {
  publishOrderFilled,
  publishPortfolioUpdated,
} from '../../events/publisher.js';

type Cursor = { createdAt: string; id: string };

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id })).toString('base64url');
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString()) as Cursor;
  } catch {
    return null;
  }
}

export async function registerOrderRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // GET /portfolios/:id/orders
  fastify.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/portfolios/:id/orders',
    { preHandler: [requirePortfolioAccess] },
    async (req, reply) => {
      const portfolioId = req.params.id;
      const parsed = paginationSchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      const limit = parsed.data.limit ?? 50;
      const cursor = parsed.data.cursor
        ? decodeCursor(parsed.data.cursor)
        : null;

      const { rows } = await pool.query<{
        id: string;
        portfolio_id: string;
        symbol: string;
        side: string;
        type: string;
        quantity: string;
        status: string;
        reject_reason: string | null;
        idempotency_key: string;
        source: string;
        created_at: Date;
      }>(
        cursor
          ? `SELECT * FROM trade_order
             WHERE portfolio_id = $1
               AND (created_at < $2 OR (created_at = $2 AND id < $3))
             ORDER BY created_at DESC, id DESC
             LIMIT $4`
          : `SELECT * FROM trade_order
             WHERE portfolio_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2`,
        cursor
          ? [portfolioId, cursor.createdAt, cursor.id, limit + 1]
          : [portfolioId, limit + 1],
      );

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor(last.created_at.toISOString(), last.id)
          : null;

      return {
        items: items.map((o) => ({
          id: o.id,
          portfolioId: o.portfolio_id,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          quantity: parseFloat(o.quantity),
          status: o.status,
          rejectReason: o.reject_reason,
          idempotencyKey: o.idempotency_key,
          source: o.source,
          createdAt: o.created_at.toISOString(),
        })),
        nextCursor,
      };
    },
  );

  // POST /portfolios/:id/orders
  fastify.post<{ Params: { id: string } }>(
    '/portfolios/:id/orders',
    { preHandler: [requirePortfolioWrite] },
    async (req, reply) => {
      const portfolioId = req.params.id;
      const parsed = createOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }

      const { symbol, side, quantity, idempotencyKey } = parsed.data;

      try {
        const result = await executeTrade({
          portfolioId,
          symbol: symbol.toUpperCase(),
          side,
          quantity,
          idempotencyKey,
          source: 'human',
        });

        // Publish realtime events only after executeTrade has committed.
        // order.filled first, then portfolio.updated (the order the client
        // contract expects). Failures here must not fail the HTTP response.
        try {
          const redis = getRedis();
          await publishOrderFilled(
            redis,
            portfolioId,
            result.order,
            result.fill,
          );
          const view = await getPortfolioView(portfolioId);
          if (view) await publishPortfolioUpdated(redis, portfolioId, view);
        } catch (pubErr) {
          req.log.warn({ err: pubErr }, 'ws publish after fill failed');
        }

        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof TradeRejectionError) {
          return reply.code(422).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  // GET /portfolios/:id/history  (valuation snapshots — populated by item 08)
  fastify.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/portfolios/:id/history',
    { preHandler: [requirePortfolioAccess] },
    async (req, reply) => {
      const portfolioId = req.params.id;
      const parsed = paginationSchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      const limit = parsed.data.limit ?? 90;
      const cursor = parsed.data.cursor
        ? decodeCursor(parsed.data.cursor)
        : null;

      const { rows } = await pool.query<{
        id: string;
        portfolio_id: string;
        taken_at: Date;
        cash: number;
        positions_value: number;
        equity: number;
      }>(
        cursor
          ? `SELECT * FROM valuation_snapshot
             WHERE portfolio_id = $1 AND taken_at < $2
             ORDER BY taken_at DESC
             LIMIT $3`
          : `SELECT * FROM valuation_snapshot
             WHERE portfolio_id = $1
             ORDER BY taken_at DESC
             LIMIT $2`,
        cursor
          ? [portfolioId, cursor.createdAt, limit + 1]
          : [portfolioId, limit + 1],
      );

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last
          ? encodeCursor(last.taken_at.toISOString(), last.id)
          : null;

      return {
        items: items.map((s) => ({
          id: s.id,
          portfolioId: s.portfolio_id,
          takenAt: s.taken_at.toISOString(),
          cash: s.cash,
          positionsValue: s.positions_value,
          equity: s.equity,
        })),
        nextCursor,
      };
    },
  );
}
