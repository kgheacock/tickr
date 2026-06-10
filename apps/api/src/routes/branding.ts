import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';

type Kind = 'logo' | 'icon';

interface BrandingRow {
  bytes: Buffer | null;
  content_type: string | null;
  fetched_at: Date | null;
}

// Branding images are downloaded into Postgres by the metadata refresh job and
// served from there — the upstream Massive URLs are Bearer-gated, so the browser
// can't hotlink them. These are non-sensitive public company logos, served
// unauthenticated so they can render pre-login and be cached by shared proxies.
// Stored bytes are immutable until the job re-fetches them (which bumps
// *_fetched_at), so that timestamp is a sound cache validator.
async function serveImage(
  kind: Kind,
  req: FastifyRequest<{ Params: { symbol: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const symbol = req.params.symbol.toUpperCase();
  const { rows } = await pool.query<BrandingRow>(
    `SELECT ${kind}_bytes        AS bytes,
            ${kind}_content_type AS content_type,
            ${kind}_fetched_at   AS fetched_at
       FROM symbol_branding
      WHERE symbol = $1`,
    [symbol],
  );

  const row = rows[0];
  if (!row || !row.bytes || !row.content_type) {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `no ${kind} for symbol ${symbol}` },
    });
  }

  // Content-based validator: re-fetching the image bumps fetched_at, which busts
  // the cache. Set the cache headers up front so the 304 path echoes them too
  // (per RFC 7232 a 304 should carry the same ETag/Cache-Control as the 200).
  const etag = `"${kind}-${row.fetched_at?.getTime() ?? 0}"`;
  reply
    // Public, long-lived, immutable within the window: the ETag changes only
    // when the job re-fetches, so a shared cache/CDN can hold it safely and a
    // conditional request revalidates after the window via the ETag.
    .header('Cache-Control', 'public, max-age=604800, immutable')
    .header('ETag', etag);

  if (req.headers['if-none-match'] === etag) {
    return reply.code(304).send();
  }

  return (
    reply
      .header('Content-Type', row.content_type)
      // An SVG opened directly (not via <img>) renders as a same-origin document
      // and could execute embedded script. nosniff + a locked-down CSP neutralize
      // that without affecting <img>/<image> rendering.
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      )
      .send(row.bytes)
  );
}

export async function registerBrandingRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // Public (no requireAuth): non-sensitive logos, cacheable by shared proxies.
  fastify.get<{ Params: { symbol: string } }>(
    '/symbols/:symbol/logo',
    (req, reply) => serveImage('logo', req, reply),
  );
  fastify.get<{ Params: { symbol: string } }>(
    '/symbols/:symbol/icon',
    (req, reply) => serveImage('icon', req, reply),
  );
}
