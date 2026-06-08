import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { replay } from '../eval/replay.js';

const orderSchema = z.object({
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().positive(),
  at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'invalid `at`' }),
});

const evaluateSchema = z.object({
  startingCash: z.number().int().nonnegative(),
  orders: z.array(orderSchema),
});

export async function registerEvaluateRoute(
  fastify: FastifyInstance,
): Promise<void> {
  // Stateless: evaluation reads price_bar and writes nothing, so no CSRF is
  // required (it is not a state-changing request).
  fastify.post(
    '/evaluate',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const parsed = evaluateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      return replay(parsed.data);
    },
  );
}
