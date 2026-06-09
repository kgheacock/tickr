import { Writable } from 'node:stream';
import { multistream, type MultiStreamRes } from 'pino';
import type { Redis } from 'ioredis';
import { getRedis } from '../redis.js';

/**
 * Cross-process log buffer (admin log viewer).
 *
 * The api/worker/bot run as separate containers, so an in-process ring buffer
 * would only ever show api lines and miss the worker jobs that do the real
 * background work. Instead every process fans its pino output into one capped
 * Redis Stream; the admin viewer (see routes/admin/logs.ts) reads it back.
 *
 * The Redis fanout is strictly best-effort: it runs alongside stdout (which
 * Docker still captures) and must never block pino or throw, so a Redis
 * outage can degrade the viewer but never the app's own logging.
 */

const LOG_STREAM_KEY = 'logs:stream';

/**
 * Approximate cap on retained log entries (`MAXLEN ~`). At ~300 bytes/line
 * this is ~1.5 MB — comfortable inside the prod Redis 256 MB limit.
 */
const LOG_STREAM_MAXLEN = 5000;

/** One stored log line: the Redis Stream id plus the raw pino JSON. */
export interface RawLogEntry {
  id: string;
  line: string;
}

/**
 * Append one raw log line to the capped stream. The hot path (the pino
 * destination below) calls this fire-and-forget; tests await it to seed the
 * stream deterministically.
 */
export async function appendRawLog(redis: Redis, line: string): Promise<void> {
  await redis.xadd(
    LOG_STREAM_KEY,
    'MAXLEN',
    '~',
    String(LOG_STREAM_MAXLEN),
    '*',
    'line',
    line,
  );
}

export interface ReadLogsResult {
  entries: RawLogEntry[];
  /** Id of the newest returned entry — pass back as `after` to tail. */
  lastId: string | null;
}

/**
 * Writable that mirrors pino output into the capped Redis Stream. Fire-and-
 * forget: each line is XADDed without awaiting and the callback fires
 * immediately, so pino never blocks on Redis and Redis errors are swallowed
 * (logging them here would risk a feedback loop through this same stream).
 */
class RedisLogStream extends Writable {
  constructor() {
    super({ decodeStrings: false });
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text =
      typeof chunk === 'string'
        ? chunk
        : String(chunk as { toString(): string });
    // pino writes one newline-terminated JSON object per log; split defensively
    // in case a write batches more than one.
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) this.fanout(trimmed);
    }
    callback();
  }

  private fanout(line: string): void {
    let redis: Redis;
    try {
      redis = getRedis();
    } catch {
      // No REDIS_URL configured (e.g. some unit tests) — stdout still works.
      return;
    }
    appendRawLog(redis, line).catch(() => {
      /* best-effort: never let log persistence break logging */
    });
  }
}

/**
 * Build the shared pino destination: stdout (so Docker keeps capturing logs)
 * plus the Redis fanout for the admin viewer.
 */
export function buildLogDestination(): MultiStreamRes {
  return multistream([
    { stream: process.stdout },
    { stream: new RedisLogStream() },
  ]);
}

function rowsToEntries(rows: [string, string[]][]): RawLogEntry[] {
  // Each row is [id, ['line', value]] — the only field we store is `line`.
  return rows.map(([id, fields]) => ({ id, line: fields[1] ?? '' }));
}

/** Most-recent `limit` entries, returned oldest → newest for display. */
export async function readRecentLogs(
  redis: Redis,
  limit: number,
): Promise<ReadLogsResult> {
  const rows = (await redis.xrevrange(
    LOG_STREAM_KEY,
    '+',
    '-',
    'COUNT',
    limit,
  )) as [string, string[]][];
  const entries = rowsToEntries(rows).reverse();
  return {
    entries,
    lastId: entries.length ? (entries[entries.length - 1]?.id ?? null) : null,
  };
}

/** Entries strictly after `afterId` (for tailing), oldest → newest. */
export async function readLogsAfter(
  redis: Redis,
  afterId: string,
  limit: number,
): Promise<ReadLogsResult> {
  const rows = (await redis.xrange(
    LOG_STREAM_KEY,
    `(${afterId}`,
    '+',
    'COUNT',
    limit,
  )) as [string, string[]][];
  const entries = rowsToEntries(rows);
  return {
    entries,
    lastId: entries.length
      ? (entries[entries.length - 1]?.id ?? afterId)
      : afterId,
  };
}
