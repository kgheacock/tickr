import type { FastifyInstance } from 'fastify';
import type { SymbolMetadata } from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';

// Columns broken out of the Massive reference payload by the metadata refresh
// job (apps/api/src/jobs/refresh-metadata.ts) into symbol_metadata. The full
// upstream `raw` JSONB and internal `updated_at` are intentionally not served:
// the response contract stays decoupled from Massive's shape.
interface MetadataRow {
  symbol: string;
  name: string | null;
  primary_exchange: string | null;
  type: string | null;
  // NUMERIC — pg returns it as a string (only int8 is parsed to Number).
  market_cap: string | null;
  sic_code: string | null;
  sic_description: string | null;
  homepage_url: string | null;
  // DATE, formatted to YYYY-MM-DD in SQL so the calendar day is timezone-proof
  // (pg's default Date parse would shift the day across UTC offsets).
  list_date: string | null;
  total_employees: number | null;
  description: string | null;
  fetched_at: Date | null;
}

function toResponse(row: MetadataRow): SymbolMetadata {
  return {
    symbol: row.symbol,
    name: row.name,
    primaryExchange: row.primary_exchange,
    type: row.type,
    // Market caps top out in the low trillions — well within float64's exact
    // integer range — so a JSON number is a safe representation here.
    marketCap: row.market_cap === null ? null : Number(row.market_cap),
    sicCode: row.sic_code,
    sicDescription: row.sic_description,
    homepageUrl: row.homepage_url,
    listDate: row.list_date,
    totalEmployees: row.total_employees,
    description: row.description,
    fetchedAt: row.fetched_at?.toISOString() ?? null,
  };
}

export async function registerMetadataRoute(
  fastify: FastifyInstance,
): Promise<void> {
  // Protected (requireAuth): company reference data behind login, matching
  // /universe and /me. Unlike the public logo/icon assets, this is not served
  // to anonymous callers.
  fastify.get<{ Params: { symbol: string } }>(
    '/symbols/:symbol/metadata',
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const symbol = req.params.symbol.toUpperCase();
      const { rows } = await pool.query<MetadataRow>(
        `SELECT symbol, name, primary_exchange, type, market_cap,
                sic_code, sic_description, homepage_url,
                to_char(list_date, 'YYYY-MM-DD') AS list_date,
                total_employees, description, fetched_at
           FROM symbol_metadata
          WHERE symbol = $1`,
        [symbol],
      );

      const row = rows[0];
      if (!row) {
        return reply.code(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `no metadata for symbol ${symbol}`,
          },
        });
      }

      return toResponse(row);
    },
  );
}
