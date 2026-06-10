/**
 * Fantasy Street item 03 — live draft routes, mounted under /api/v1.
 *   POST /leagues/:id/draft        schedule the draft (commissioner, full league)
 *   POST /leagues/:id/draft/start  start it; first seat goes on the clock
 *   POST /leagues/:id/draft/pick   the on-the-clock manager picks a stock
 *   GET  /leagues/:id/draft        the live board + clock
 *
 * The handlers are thin glue over the pure domain in fantasy/draft.ts. The pick
 * clock (Redis deadline + in-process timer + WS broadcasts) is the singleton in
 * fantasy/draftClock.ts; routes arm it on start and advance it on every pick.
 */
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { DraftState } from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import { getRedis } from '../../redis.js';
import {
  requireCommissioner,
  requireLeagueMember,
} from '../../fantasy/guards.js';
import {
  scheduleDraft,
  startDraft,
  makePick,
  getDraftState,
} from '../../fantasy/draft.js';
import { createDraftClock, type DraftClock } from '../../fantasy/draftClock.js';
import { sendFantasyError } from './_shared.js';

let clock: DraftClock | undefined;
/** Lazily build the process-wide draft clock (one api instance, one clock). */
function draftClock(): DraftClock {
  clock ??= createDraftClock(pool, getRedis());
  return clock;
}

/** Overlay the live Redis deadline onto an in-progress board. */
async function withDeadline(
  redis: Redis,
  state: DraftState,
): Promise<DraftState> {
  if (state.status !== 'in_progress') return state;
  const raw = await redis.get(`fs:draft:${state.id}:deadline`);
  if (!raw) return state;
  return { ...state, deadline: new Date(Number(raw)).toISOString() };
}

export function registerDraftRoutes(fastify: FastifyInstance): void {
  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/draft',
    async (req, reply) => {
      if (!(await requireCommissioner(req, reply, req.params.id))) return;
      try {
        const state = await scheduleDraft(pool, req.params.id);
        return reply.code(201).send(state);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/draft/start',
    async (req, reply) => {
      if (!(await requireCommissioner(req, reply, req.params.id))) return;
      try {
        const state = await startDraft(pool, req.params.id);
        const armed = await draftClock().arm(req.params.id, true);
        return armed ? { ...state, deadline: armed.deadline } : state;
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: { symbol?: string; isShort?: boolean };
  }>('/leagues/:id/draft/pick', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const symbol = req.body?.symbol?.trim();
    if (!symbol) {
      return reply
        .code(422)
        .send({ error: { code: 'VALIDATION', message: 'symbol is required' } });
    }
    try {
      const result = await makePick(
        pool,
        req.params.id,
        req.userId!,
        symbol,
        req.body?.isShort === true,
      );
      await draftClock().broadcastPick(req.params.id, result);
      return withDeadline(getRedis(), result.state);
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.get<{ Params: { id: string } }>(
    '/leagues/:id/draft',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      const state = await getDraftState(pool, req.params.id);
      if (!state) {
        return reply
          .code(404)
          .send({ error: { code: 'NOT_FOUND', message: 'No draft yet' } });
      }
      return withDeadline(getRedis(), state);
    },
  );
}
