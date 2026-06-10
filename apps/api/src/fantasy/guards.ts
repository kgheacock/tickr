/**
 * Fantasy Street authorization guards (item 01) — thin Fastify-layer wrappers
 * over the domain authz primitives in leagues.ts, both layered on requireAuth.
 *
 * The real enforcement lives in the domain functions (so it's testable without
 * Redis); these adapt the FantasyError they throw into an HTTP reply, giving
 * later FS items (draft, lineups, …) a one-line gate at the top of a handler.
 * Each returns true when the caller is authorized; on failure it has already
 * sent the response and the handler must return.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';
import {
  FantasyError,
  assertCommissioner,
  assertLeagueMember,
  fantasyErrorStatus,
} from './leagues.js';

async function runGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  check: (userId: string) => Promise<void>,
): Promise<boolean> {
  await requireAuth(req, reply);
  if (!req.userId) return false; // requireAuth already sent 401
  try {
    await check(req.userId);
    return true;
  } catch (err) {
    if (err instanceof FantasyError) {
      reply
        .code(fantasyErrorStatus(err.code))
        .send({ error: { code: err.code, message: err.message } });
      return false;
    }
    throw err;
  }
}

/** Authenticated caller must be a member of the league. */
export function requireLeagueMember(
  req: FastifyRequest,
  reply: FastifyReply,
  leagueId: string,
): Promise<boolean> {
  return runGuard(req, reply, (userId) =>
    assertLeagueMember(pool, leagueId, userId),
  );
}

/** Authenticated caller must be the league's commissioner. */
export function requireCommissioner(
  req: FastifyRequest,
  reply: FastifyReply,
  leagueId: string,
): Promise<boolean> {
  return runGuard(req, reply, (userId) =>
    assertCommissioner(pool, leagueId, userId),
  );
}
