import { pino } from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import { randomUUID } from 'node:crypto';

/**
 * Centralized structured logging (item 10).
 *
 * Every line carries `level`, `time`, `msg`, plus a correlation id:
 * `request_id` for HTTP (stamped by Fastify's `genReqId`, see roles/api.ts)
 * or `job_id` for worker components (see {@link jobLogger}).
 *
 * Redaction targets the real secret-leak paths — the `Authorization` header
 * (carries the bearer/session), the `Cookie` request header, and the
 * `Set-Cookie` response header. `MASSIVE_API_KEY` is never placed in a log
 * field (the Massive client logs only the path), so it cannot appear here.
 */

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'authorization',
  'cookie',
  '["set-cookie"]',
];

export const baseLoggerOptions: LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? 'info',
  // Emit the level as its string label (`info`) rather than pino's numeric
  // default, matching the JSON the worker components used to print by hand.
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
};

/** Generate the per-request correlation id used as `request_id`. */
export function genRequestId(): string {
  return randomUUID();
}

/** Standalone root logger for non-Fastify contexts (the worker process). */
export const rootLogger: Logger = pino(baseLoggerOptions);

/**
 * Child logger for a worker job/component. Every line gets `component` and a
 * `job_id` so a single run can be correlated end-to-end. Pass a shared
 * `jobId` to tie multiple components to one run; omit it for a fresh id.
 */
export function jobLogger(
  component: string,
  jobId: string = randomUUID(),
): Logger {
  return rootLogger.child({ component, job_id: jobId });
}
