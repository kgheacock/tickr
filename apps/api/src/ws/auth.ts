import type { IncomingMessage } from 'node:http';
import type { Redis } from 'ioredis';
import { getSession } from '../auth/session.js';

const SESSION_COOKIE = 'tickr_sid';

/**
 * Parse a `Cookie:` header into a name→value map. The upgrade request is a raw
 * `http.IncomingMessage`, so `@fastify/cookie` has not run and we parse here.
 */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function readSessionToken(req: IncomingMessage): string | null {
  const cookies = parseCookies(req.headers.cookie);
  // The session cookie is unsigned (see routes/auth/callback.ts) — the raw
  // value is the session token.
  return cookies[SESSION_COOKIE] ?? null;
}

/**
 * Authenticate a WS upgrade request. Returns the userId on a valid live session,
 * or null otherwise (the caller rejects the upgrade with 401).
 */
export async function authenticateUpgrade(
  redis: Redis,
  req: IncomingMessage,
): Promise<string | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const record = await getSession(redis, token);
  return record?.userId ?? null;
}
