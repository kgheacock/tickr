import type { FastifyInstance } from 'fastify';
import type { PricesResponse, PriceBar } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';

/** Corpus size cap — documented in openapi.yaml (`/prices`). */
export const MAX_PRICE_SYMBOLS = 100;
/** Window cap: ≈2 years of daily bars (matches the backfill lookback, D2). */
export const MAX_WINDOW_DAYS = 730;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface BarRow {
  symbol: string;
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: string | null; // NUMERIC → string from pg
}

function serializeBar(r: BarRow): PriceBar {
  return {
    ts: r.ts.toISOString(),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume === null ? null : Number(r.volume),
  };
}

export interface PricesQuery {
  symbols: string[];
  from?: string | undefined;
  to?: string | undefined;
}

/**
 * Reads `price_bar` only (D4 — `price_bar` is the sole source of truth). Each
 * requested symbol must be in `universe_symbol`; symbols that are unknown or
 * produce no bars in the resolved window land in `missing` rather than failing
 * the whole request. The window is clamped to {@link MAX_WINDOW_DAYS}.
 */
export async function loadPrices(q: PricesQuery): Promise<PricesResponse> {
  const toMs = q.to ? Date.parse(q.to) : Date.now();
  if (Number.isNaN(toMs)) throw new RangeError('invalid `to`');
  let fromMs = q.from ? Date.parse(q.from) : toMs - MAX_WINDOW_MS;
  if (Number.isNaN(fromMs)) throw new RangeError('invalid `from`');
  // Clamp the window to the documented cap.
  if (toMs - fromMs > MAX_WINDOW_MS) fromMs = toMs - MAX_WINDOW_MS;

  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  const requested = [...new Set(q.symbols.map((s) => s.toUpperCase()))];
  if (requested.length > MAX_PRICE_SYMBOLS) {
    throw new RangeError(`at most ${MAX_PRICE_SYMBOLS} symbols`);
  }

  // Which requested symbols actually exist in the corpus.
  const { rows: known } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol WHERE symbol = ANY($1)`,
    [requested],
  );
  const knownSet = new Set(known.map((r) => r.symbol));

  const series: PricesResponse['series'] = {};
  if (knownSet.size > 0) {
    const { rows } = await pool.query<BarRow>(
      `SELECT symbol, ts, open, high, low, close, volume
         FROM price_bar
        WHERE symbol = ANY($1) AND ts BETWEEN $2 AND $3
        ORDER BY symbol, ts`,
      [[...knownSet], from, to],
    );
    for (const r of rows) {
      (series[r.symbol] ??= []).push(serializeBar(r));
    }
  }

  // Unknown symbols, plus known-but-no-bars-in-window symbols, are "missing".
  const missing = requested.filter((s) => !(s in series));

  return { from, to, series, missing };
}

export async function registerPricesRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get<{
    Querystring: { symbols?: string; from?: string; to?: string };
  }>('/prices', { preHandler: [requireAuth] }, async (req, reply) => {
    const raw = (req.query.symbols ?? '').trim();
    const symbols = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    if (symbols.length === 0) {
      return reply.code(422).send({
        error: { code: 'VALIDATION', message: '`symbols` is required' },
      });
    }

    try {
      return await loadPrices({
        symbols,
        from: req.query.from,
        to: req.query.to,
      });
    } catch (err) {
      if (err instanceof RangeError) {
        return reply
          .code(422)
          .send({ error: { code: 'VALIDATION', message: err.message } });
      }
      throw err;
    }
  });
}
