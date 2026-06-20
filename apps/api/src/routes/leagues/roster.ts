/**
 * Fantasy Street — immediate free-agent roster routes, mounted under /api/v1.
 *   POST   /leagues/:id/roster          buy: add an unowned stock (drop when full)
 *   DELETE /leagues/:id/roster/:symbol  sell: drop one of the caller's stocks
 *
 * Thin glue over fantasy/roster.ts; the window gate and the single-owner award
 * live there. Distinct from /waivers, which queues contested claims for the run.
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import { addPlayer, dropPlayer } from '../../fantasy/roster.js';
import { sendFantasyError } from './_shared.js';

export function registerRosterRoutes(fastify: FastifyInstance): void {
  fastify.post<{
    Params: { id: string };
    Body: { addSymbol?: string; dropSymbol?: string; isShort?: boolean };
  }>('/leagues/:id/roster', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const addSymbol = req.body?.addSymbol?.trim();
    if (!addSymbol) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'addSymbol is required' },
      });
    }
    try {
      const result = await addPlayer(pool, req.params.id, req.userId!, {
        addSymbol,
        dropSymbol: req.body?.dropSymbol?.trim() || undefined,
        isShort: req.body?.isShort === true,
      });
      return reply.code(201).send(result);
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.delete<{ Params: { id: string; symbol: string } }>(
    '/leagues/:id/roster/:symbol',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      try {
        return await dropPlayer(
          pool,
          req.params.id,
          req.userId!,
          req.params.symbol,
        );
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
