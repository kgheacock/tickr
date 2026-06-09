import { describe, it, expect } from 'vitest';
import { pino } from 'pino';
import Fastify from 'fastify';
import { baseLoggerOptions, genRequestId } from '../../src/log/logger.js';

/** Capture one serialized log line written through our base logger options. */
function logLine(obj: object, msg: string): string {
  let captured = '';
  const stream = {
    write: (chunk: string) => {
      captured += chunk;
    },
  };
  const log = pino(baseLoggerOptions, stream);
  log.info(obj, msg);
  return captured;
}

describe('logger redaction', () => {
  it('redacts Authorization, Cookie, and Set-Cookie from log lines', () => {
    const line = logLine(
      {
        req: {
          headers: {
            authorization: 'Bearer super-secret-token',
            cookie: 'tickr_sid=secret-session',
          },
        },
        res: { headers: { 'set-cookie': 'tickr_sid=secret-session' } },
      },
      'request',
    );

    expect(line).not.toContain('super-secret-token');
    expect(line).not.toContain('secret-session');
    expect(line).toContain('[REDACTED]');
  });

  it('emits level as a string label and includes time + msg', () => {
    const line = logLine({}, 'hello');
    const parsed = JSON.parse(line) as {
      level: string;
      time: number;
      msg: string;
    };
    expect(parsed.level).toBe('info');
    expect(typeof parsed.time).toBe('number');
    expect(parsed.msg).toBe('hello');
  });
});

describe('Fastify request logging', () => {
  it('stamps request_id on every HTTP log line', async () => {
    let captured = '';
    const stream = {
      write: (chunk: string) => {
        captured += chunk;
      },
    };
    const app = Fastify({
      logger: { ...baseLoggerOptions, level: 'info', stream },
      genReqId: genRequestId,
      requestIdLogLabel: 'request_id',
    });
    app.get('/x', async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: 'GET', url: '/x' });
    await app.close();

    // Fastify logs at least one line per request; each must carry request_id.
    const lines = captured.trim().split('\n').filter(Boolean);
    const requestLines = lines
      .map((l) => JSON.parse(l) as { request_id?: string; req?: unknown })
      .filter((o) => o.req !== undefined || o.request_id !== undefined);
    expect(requestLines.length).toBeGreaterThan(0);
    for (const line of requestLines) {
      expect(typeof line.request_id).toBe('string');
    }
  });
});
