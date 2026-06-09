import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StrategyBacktestResponse } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';
import { etfSeries } from '../etf/series.js';
import { replay } from '../eval/replay.js';
import {
  DEFAULT_SHORT_WINDOW,
  DEFAULT_LONG_WINDOW,
  runSmaCrossover,
  buyAndHoldCurve,
  totalReturnPct,
  maxDrawdownPct,
} from '../strategy/sma-crossover.js';

const DEFAULT_STARTING_CASH = 1_000_000; // cents ($10,000)

const smaStrategySchema = z.object({
  etfKey: z.string().min(1),
  shortWindow: z.number().int().positive().optional(),
  longWindow: z.number().int().positive().optional(),
  startingCash: z.number().int().nonnegative().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function registerStrategyRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Stateless backtest: reads price_bar / the synthetic ETF series and writes
  // nothing (same posture as /evaluate), so no CSRF is required.
  fastify.post(
    '/strategies/sma-crossover',
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = smaStrategySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'VALIDATION', message: parsed.error.message },
        });
      }
      const {
        etfKey,
        shortWindow = DEFAULT_SHORT_WINDOW,
        longWindow = DEFAULT_LONG_WINDOW,
        startingCash = DEFAULT_STARTING_CASH,
      } = parsed.data;

      if (shortWindow >= longWindow) {
        return reply.code(422).send({
          error: {
            code: 'VALIDATION',
            message: 'shortWindow must be less than longWindow',
          },
        });
      }

      // Default the window to the ETF's base_date → now. Starting at base_date
      // keeps the plotted region to where every member has a bar (before that,
      // etfSeries skips a missing member but still counts its weight, distorting
      // the level). Callers may pass an earlier `from` explicitly.
      const { rows: etfRows } = await pool.query<{ base_date: string }>(
        `SELECT base_date::text AS base_date FROM etf WHERE key = $1`,
        [etfKey],
      );
      if (etfRows.length === 0) {
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: `ETF not found: ${etfKey}` },
        });
      }
      const to = parsed.data.to ?? new Date().toISOString();
      const from = parsed.data.from ?? `${etfRows[0]!.base_date}T00:00:00Z`;

      let series;
      try {
        series = await etfSeries(pool, etfKey, { from, to });
      } catch (err) {
        if (err instanceof RangeError) {
          const status = err.message.includes('not found') ? 404 : 422;
          const code = status === 404 ? 'NOT_FOUND' : 'VALIDATION';
          return reply
            .code(status)
            .send({ error: { code, message: err.message } });
        }
        throw err;
      }

      const daily = series.map((b) => ({ ts: b.ts, close: b.close }));
      const { orders, equityCurve } = runSmaCrossover(
        daily,
        `etf:${etfKey}`,
        startingCash,
        { shortWindow, longWindow },
      );
      const buyHold = buyAndHoldCurve(daily, startingCash);

      // Replay the order series through the same engine /evaluate uses, for the
      // faithful point-in-time fills (satisfies the "runs through /evaluate" DoD
      // bullet). The plotted curve comes from the dense daily series above.
      const evaluated = await replay({ startingCash, orders });

      const response: StrategyBacktestResponse = {
        etfKey,
        shortWindow,
        longWindow,
        startingCash,
        from: daily[0]?.ts ?? from,
        to: daily[daily.length - 1]?.ts ?? to,
        strategy: {
          equityCurve,
          totalReturnPct: totalReturnPct(equityCurve, startingCash),
          maxDrawdownPct: maxDrawdownPct(equityCurve),
        },
        buyHold: {
          equityCurve: buyHold,
          totalReturnPct: totalReturnPct(buyHold, startingCash),
          maxDrawdownPct: maxDrawdownPct(buyHold),
        },
        orders: evaluated.orders,
      };
      return response;
    },
  );
}
