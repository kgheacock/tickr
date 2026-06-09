import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth, requireCsrf } from '../auth/middleware.js';
import {
  EtfError,
  createEtf,
  listEtfs,
  loadEtf,
  getEtfReturns,
} from '../etf/crud.js';

const createEtfSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/, 'key must be lowercase alphanumeric, _ or -'),
  name: z.string().min(1),
  baseDate: z.string().optional(),
  baseValue: z.number().int().positive().optional(),
  weights: z.record(z.string(), z.number().positive()),
});

export async function registerEtfsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    '/etfs',
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async () => {
      return { items: await listEtfs(pool) };
    },
  );

  fastify.get<{ Params: { key: string } }>(
    '/etfs/:key',
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const etf = await loadEtf(req.params.key, pool);
      if (!etf) {
        return reply.code(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `ETF not found: ${req.params.key}`,
          },
        });
      }
      return etf;
    },
  );

  fastify.post(
    '/etfs',
    {
      preHandler: [requireAuth, requireCsrf],
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = createEtfSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      try {
        const etf = await createEtf(parsed.data, pool);
        return reply.code(201).send(etf);
      } catch (err) {
        if (err instanceof EtfError) {
          const status = err.code === 'NOT_FOUND' ? 404 : 422;
          return reply
            .code(status)
            .send({ error: { code: err.code, message: err.message } });
        }
        throw err;
      }
    },
  );

  fastify.get<{
    Params: { key: string };
    Querystring: { from?: string; to?: string };
  }>(
    '/etfs/:key/returns',
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const to = req.query.to ?? new Date().toISOString();
      const toMs = Date.parse(to);
      if (Number.isNaN(toMs)) {
        return reply
          .code(422)
          .send({ error: { code: 'VALIDATION', message: 'invalid `to`' } });
      }
      const from =
        req.query.from ??
        new Date(toMs - 365 * 24 * 60 * 60 * 1000).toISOString();

      try {
        return await getEtfReturns(req.params.key, from, to, pool);
      } catch (err) {
        if (err instanceof EtfError) {
          const status = err.code === 'NOT_FOUND' ? 404 : 422;
          return reply
            .code(status)
            .send({ error: { code: err.code, message: err.message } });
        }
        if (err instanceof RangeError) {
          // etfSeries not found
          if (err.message.includes('not found')) {
            return reply
              .code(404)
              .send({ error: { code: 'NOT_FOUND', message: err.message } });
          }
          return reply
            .code(422)
            .send({ error: { code: 'VALIDATION', message: err.message } });
        }
        throw err;
      }
    },
  );
}
