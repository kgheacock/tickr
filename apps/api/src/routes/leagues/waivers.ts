/**
 * Fantasy Street item 07 — waiver routes, mounted under /api/v1.
 *   POST /leagues/:id/waivers   queue an add/drop claim
 *   GET  /leagues/:id/waivers   my claims + the league waiver order
 *
 * Thin glue over the domain in fantasy/waivers.ts; the contested-award logic and
 * the rolling priority live there and run from the scheduler (waiver run).
 */
import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import { submitWaiverClaim, listWaivers } from '../../fantasy/waivers.js';
import { sendFantasyError } from './_shared.js';

export function registerWaiverRoutes(fastify: FastifyInstance): void {
  fastify.post<{
    Params: { id: string };
    Body: { addSymbol?: string; dropSymbol?: string; isShort?: boolean };
  }>('/leagues/:id/waivers', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const addSymbol = req.body?.addSymbol?.trim();
    const dropSymbol = req.body?.dropSymbol?.trim();
    if (!addSymbol || !dropSymbol) {
      return reply.code(422).send({
        error: {
          code: 'VALIDATION',
          message: 'addSymbol and dropSymbol are required',
        },
      });
    }
    try {
      const claim = await submitWaiverClaim(pool, req.params.id, req.userId!, {
        addSymbol,
        dropSymbol,
        isShort: req.body?.isShort === true,
      });
      return reply.code(201).send(claim);
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.get<{ Params: { id: string } }>(
    '/leagues/:id/waivers',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      try {
        return await listWaivers(pool, req.params.id, req.userId!);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
