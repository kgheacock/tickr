/**
 * Shared glue for the /leagues route handlers: turn a thrown FantasyError into
 * the matching HTTP reply, and rethrow anything else for the global handler.
 */
import type { FastifyReply } from 'fastify';
import { FantasyError, fantasyErrorStatus } from '../../fantasy/leagues.js';

export function sendFantasyError(
  reply: FastifyReply,
  err: unknown,
): never | FastifyReply {
  if (err instanceof FantasyError) {
    return reply
      .code(fantasyErrorStatus(err.code))
      .send({ error: { code: err.code, message: err.message } });
  }
  throw err;
}
