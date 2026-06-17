import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { requireAuth, requireCsrf } from '../../auth/middleware.js';
import { createLeague, getLeagueView } from '../../fantasy/leagues.js';
import { autoDraftFullLeague } from '../../fantasy/autoDraftLeague.js';
import { sendFantasyError } from './_shared.js';

const rosterConfigSchema = z.object({
  slots: z.array(z.string()),
  bench: z.number().int(),
});

const memberSchema = z.object({
  email: z.string().nullish(),
  isBot: z.boolean(),
});

const createSchema = z.object({
  name: z.string().min(1),
  teamName: z.string().nullish(),
  // Optional: capacity is derived from `members` when present (see createLeague).
  size: z.number().int().optional(),
  seasonLengthWeeks: z.number().int(),
  rosterConfig: rosterConfigSchema.optional(),
  joinPolicy: z.enum(['invite', 'open']),
  members: z.array(memberSchema).optional(),
});

export function registerCreateLeagueRoute(fastify: FastifyInstance): void {
  fastify.post(
    '/leagues',
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      try {
        const view = await createLeague(parsed.data, req.userId!, pool);
        // Instant play (FS-14): an all-bot league has no open seats, so it's
        // full on creation — run the whole draft now so the commissioner lands
        // on an active, playable league. Best-effort: a draft failure must not
        // fail the create that already succeeded, so re-read and return either
        // way (the league simply stays `forming` if the draft was skipped).
        if (view.openSlots === 0) {
          try {
            await autoDraftFullLeague(pool, view.id);
          } catch (err) {
            req.log.error(
              { err, leagueId: view.id },
              'auto-draft on league create failed',
            );
          }
          const drafted = await getLeagueView(view.id, req.userId!, pool);
          return reply.code(201).send(drafted);
        }
        return reply.code(201).send(view);
      } catch (err) {
        return sendFantasyError(reply, err);
      }
    },
  );
}
