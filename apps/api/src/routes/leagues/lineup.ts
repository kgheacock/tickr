/**
 * Fantasy Street item 04 — weekly lineup routes, mounted under /api/v1.
 *   GET  /leagues/:id/lineup?week=&season=   the manager's lineup for the week
 *   PUT  /leagues/:id/lineup                 set the starting lineup
 *   POST /leagues/:id/lineup/autofill        fill remaining mandatory slots
 *
 * Thin glue over the pure domain in fantasy/lineup.ts; the Monday-open lock is
 * the cron in jobs/scheduler.ts driving fantasy/lock.ts. Week is supplied by the
 * caller (FS-06 will own the schedule→week mapping); season defaults to 1.
 */
import type { FastifyInstance } from 'fastify';
import type { SetLineupRequest } from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import {
  getLineup,
  setLineup,
  autofillRemaining,
} from '../../fantasy/lineup.js';
import { sendFantasyError } from './_shared.js';

/** Parse a 1-based integer query param, or undefined when absent/blank. */
function intParam(raw: string | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

export function registerLineupRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { id: string };
    Querystring: { week?: string; season?: string };
  }>('/leagues/:id/lineup', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const week = intParam(req.query.week) ?? 1;
    const season = intParam(req.query.season) ?? 1;
    if (Number.isNaN(week) || Number.isNaN(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'week/season must be integers' },
      });
    }
    try {
      return await getLineup(pool, req.params.id, req.userId!, week, season);
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.put<{ Params: { id: string }; Body: SetLineupRequest }>(
    '/leagues/:id/lineup',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      const body = req.body;
      if (!body || !Number.isInteger(body.week) || !Array.isArray(body.slots)) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: 'week and slots are required' },
        });
      }
      try {
        return await setLineup(pool, req.params.id, req.userId!, {
          week: body.week,
          season: body.season ?? 1,
          slots: body.slots,
        });
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: { week?: number; season?: number };
  }>('/leagues/:id/lineup/autofill', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const week = req.body?.week ?? 1;
    const season = req.body?.season ?? 1;
    if (!Number.isInteger(week) || !Number.isInteger(season)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'week/season must be integers' },
      });
    }
    try {
      return await autofillRemaining(
        pool,
        req.params.id,
        req.userId!,
        week,
        season,
      );
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });
}
