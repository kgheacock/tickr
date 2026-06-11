/**
 * Fantasy Street item 07 — trade routes, mounted under /api/v1.
 *   POST /leagues/:id/trades                  propose a trade
 *   GET  /leagues/:id/trades                  my incoming + outgoing trades
 *   POST /leagues/:id/trades/:tradeId/accept  target accepts (swaps ownership)
 *   POST /leagues/:id/trades/:tradeId/reject  target rejects
 *   POST /leagues/:id/trades/:tradeId/cancel  proposer cancels
 *
 * Thin glue over fantasy/trades.ts. On a successful accept the route publishes
 * trade.accepted (post-commit), mirroring how the draft route broadcasts a pick.
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { getRedis } from '../../redis.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import {
  proposeTrade,
  respondToTrade,
  listTrades,
  type TradeAction,
} from '../../fantasy/trades.js';
import { publishTradeAccepted } from '../../events/publisher.js';
import { sendFantasyError } from './_shared.js';

export function registerTradeRoutes(fastify: FastifyInstance): void {
  fastify.post<{
    Params: { id: string };
    Body: { targetUserId?: string; give?: string[]; receive?: string[] };
  }>('/leagues/:id/trades', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const targetUserId = req.body?.targetUserId?.trim();
    if (!targetUserId) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'targetUserId is required' },
      });
    }
    try {
      const trade = await proposeTrade(pool, req.params.id, req.userId!, {
        targetUserId,
        give: req.body?.give ?? [],
        receive: req.body?.receive ?? [],
      });
      return reply.code(201).send(trade);
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.get<{ Params: { id: string } }>(
    '/leagues/:id/trades',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      try {
        return await listTrades(pool, req.params.id, req.userId!);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  for (const action of ['accept', 'reject', 'cancel'] as const) {
    fastify.post<{ Params: { id: string; tradeId: string } }>(
      `/leagues/:id/trades/:tradeId/${action}`,
      async (req, reply) => {
        if (!(await requireLeagueMember(req, reply, req.params.id))) return;
        try {
          const trade = await respondToTrade(
            pool,
            req.params.id,
            req.params.tradeId,
            req.userId!,
            action satisfies TradeAction,
          );
          if (action === 'accept' && trade.status === 'accepted') {
            await publishTradeAccepted(getRedis(), {
              leagueId: trade.leagueId,
              tradeId: trade.id,
              proposerUserId: trade.proposerUserId,
              targetUserId: trade.targetUserId,
            });
          }
          return trade;
        } catch (err) {
          return sendFantasyError(reply, err);
        }
      },
    );
  }
}
