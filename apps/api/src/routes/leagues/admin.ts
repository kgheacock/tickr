/**
 * Fantasy Street item 12 — commissioner & admin tool routes, mounted under
 * /api/v1.
 *   PATCH  /leagues/:id/settings                 mid-season-safe settings
 *   DELETE /leagues/:id/members/:userId          remove a pre-draft member
 *   PATCH  /leagues/:id/members/:userId          rename team / transfer role
 *   POST   /leagues/:id/admin/rescore            dispute re-score a week
 *   POST   /leagues/:id/admin/advance            force-advance a stuck week
 *   POST   /leagues/:id/admin/lineup/:userId     override a manager's lineup
 *   GET    /leagues/:id/admin/audit              the league's audit trail
 *
 * Thin glue over fantasy/admin.ts; the commissioner check + every rule live
 * there (exercised without Redis), so a failure throws FantasyError and maps via
 * sendFantasyError. State-changing actions carry requireCsrf like the other
 * commissioner mutations (bots/invites/settings); the re-score and force-advance
 * publish the same events the Friday job does so live clients refresh.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { getRedis } from '../../redis.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';
import { requireCommissioner } from '../../fantasy/guards.js';
import {
  publishScoreUpdated,
  publishMatchupUpdated,
  publishSeasonChampion,
} from '../../events/publisher.js';
import {
  updateMidSeasonSettings,
  removeMember,
  renameTeam,
  transferCommissioner,
  rescoreWeek,
  forceAdvance,
  overrideLineup,
} from '../../fantasy/admin.js';
import { listAudit } from '../../fantasy/audit.js';
import type { AuditResponse } from '@tickr/shared-types';
import { sendFantasyError } from './_shared.js';

const rosterConfigSchema = z.object({
  slots: z.array(z.string()),
  bench: z.number().int(),
});

const settingsSchema = z.object({
  name: z.string().min(1).optional(),
  joinPolicy: z.enum(['invite', 'open']).optional(),
  size: z.number().int().optional(),
  seasonLengthWeeks: z.number().int().optional(),
  rosterConfig: rosterConfigSchema.optional(),
});

// Rename xor transfer: a team name, or the commissioner-role promotion.
const memberPatchSchema = z.union([
  z.object({ teamName: z.string() }),
  z.object({ role: z.literal('commissioner') }),
]);

const slotSchema = z.object({
  slot: z.string(),
  slotIndex: z.number().int().optional(),
  symbol: z.string(),
});

const rescoreSchema = z.object({
  week: z.number().int(),
  season: z.number().int().optional(),
  reason: z.string().optional(),
});

const advanceSchema = z.object({
  week: z.number().int().optional(),
  season: z.number().int().optional(),
  reason: z.string().optional(),
});

const lineupOverrideSchema = z.object({
  week: z.number().int(),
  season: z.number().int().optional(),
  slots: z.array(slotSchema).optional(),
  unlock: z.boolean().optional(),
  lock: z.boolean().optional(),
  reason: z.string().optional(),
});

function badRequest(reply: import('fastify').FastifyReply, message: string) {
  return reply.code(422).send({ error: { code: 'VALIDATION', message } });
}

export function registerAdminToolRoutes(fastify: FastifyInstance): void {
  // --- Mid-season settings --------------------------------------------------
  fastify.patch<{ Params: { id: string } }>(
    '/leagues/:id/settings',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = settingsSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error.message);
      try {
        return await updateMidSeasonSettings(
          pool,
          req.params.id,
          parsed.data,
          req.userId!,
        );
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  // --- Member management ----------------------------------------------------
  fastify.delete<{ Params: { id: string; userId: string } }>(
    '/leagues/:id/members/:userId',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      try {
        return await removeMember(
          pool,
          req.params.id,
          req.params.userId,
          req.userId!,
        );
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  fastify.patch<{ Params: { id: string; userId: string } }>(
    '/leagues/:id/members/:userId',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = memberPatchSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error.message);
      try {
        if ('role' in parsed.data) {
          return await transferCommissioner(
            pool,
            req.params.id,
            req.params.userId,
            req.userId!,
          );
        }
        return await renameTeam(
          pool,
          req.params.id,
          req.params.userId,
          parsed.data.teamName,
          req.userId!,
        );
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  // --- Dispute re-score -----------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/admin/rescore',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = rescoreSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error.message);
      const redis = getRedis();
      try {
        const result = await rescoreWeek(
          pool,
          req.params.id,
          parsed.data.week,
          req.userId!,
          {
            ...(parsed.data.season !== undefined
              ? { season: parsed.data.season }
              : {}),
            ...(parsed.data.reason !== undefined
              ? { reason: parsed.data.reason }
              : {}),
          },
          redis,
        );
        await publishScoreUpdated(redis, {
          leagueId: req.params.id,
          season: result.season,
          week: result.week,
        });
        await publishMatchupUpdated(
          redis,
          req.params.id,
          result.season,
          result.week,
          result.scores,
          false,
        );
        if (result.settle.championUserId) {
          await publishSeasonChampion(redis, {
            leagueId: req.params.id,
            season: result.season,
            championUserId: result.settle.championUserId,
          });
        }
        return result;
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  // --- Force-advance --------------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    '/leagues/:id/admin/advance',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = advanceSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error.message);
      const redis = getRedis();
      try {
        const result = await forceAdvance(pool, req.params.id, req.userId!, {
          ...(parsed.data.week !== undefined ? { week: parsed.data.week } : {}),
          ...(parsed.data.season !== undefined
            ? { season: parsed.data.season }
            : {}),
          ...(parsed.data.reason !== undefined
            ? { reason: parsed.data.reason }
            : {}),
        });
        if (result.settle.championUserId) {
          await publishSeasonChampion(redis, {
            leagueId: req.params.id,
            season: result.season,
            championUserId: result.settle.championUserId,
          });
        }
        return result;
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  // --- Lineup override ------------------------------------------------------
  fastify.post<{ Params: { id: string; userId: string } }>(
    '/leagues/:id/admin/lineup/:userId',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = lineupOverrideSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error.message);
      try {
        return await overrideLineup(
          pool,
          req.params.id,
          req.params.userId,
          parsed.data,
          req.userId!,
        );
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );

  // --- Audit trail (read) ---------------------------------------------------
  fastify.get<{
    Params: { id: string };
    Querystring: { limit?: string };
  }>('/leagues/:id/admin/audit', async (req, reply) => {
    if (!(await requireCommissioner(req, reply, req.params.id))) return;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (limit !== undefined && !Number.isInteger(limit)) {
      return badRequest(reply, 'limit must be an integer');
    }
    try {
      const entries = await listAudit(pool, req.params.id, limit);
      return { entries } satisfies AuditResponse;
    } catch (err) {
      return sendFantasyError(reply, err);
    }
  });
}
