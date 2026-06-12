/**
 * Fantasy Street item 11 — notification feed routes, mounted under /api/v1.
 *   GET  /leagues/:id/notifications?before=&limit=   my feed, newest first
 *   POST /leagues/:id/notifications/:nid/read         mark one read
 *
 * Thin glue over the domain in fantasy/notifications.ts. The feed is always the
 * caller's own (scoped by req.userId), so league membership is the only gate.
 * Reminders are written by the worker/draft route; recaps by the scoring job.
 */
import type { FastifyInstance } from 'fastify';
import type { NotificationsResponse } from '@tickr/shared-types';
import { pool } from '../../db/pool.js';
import { requireLeagueMember } from '../../fantasy/guards.js';
import {
  listNotifications,
  markRead,
  type FeedOptions,
} from '../../fantasy/notifications.js';
import { sendFantasyError } from './_shared.js';

export function registerNotificationRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { id: string };
    Querystring: { before?: string; limit?: string };
  }>('/leagues/:id/notifications', async (req, reply) => {
    if (!(await requireLeagueMember(req, reply, req.params.id))) return;
    const rawLimit = req.query.limit;
    const limit =
      rawLimit == null || rawLimit === '' ? undefined : Number(rawLimit);
    if (limit !== undefined && !Number.isInteger(limit)) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: 'limit must be an integer' },
      });
    }
    const feedOpts: FeedOptions = {};
    if (req.query.before) feedOpts.before = req.query.before;
    if (limit !== undefined) feedOpts.limit = limit;
    try {
      const notifications = await listNotifications(
        pool,
        req.params.id,
        req.userId!,
        feedOpts,
      );
      return { notifications } satisfies NotificationsResponse;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });

  fastify.post<{ Params: { id: string; nid: string } }>(
    '/leagues/:id/notifications/:nid/read',
    async (req, reply) => {
      if (!(await requireLeagueMember(req, reply, req.params.id))) return;
      try {
        return await markRead(pool, req.params.id, req.userId!, req.params.nid);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
