import type { Redis } from 'ioredis';
import pLimit from 'p-limit';
import { pool } from '../db/pool.js';
import { massiveGetPaged } from '../massive/client.js';
import type { components } from '../massive/massive.gen.js';
import { insertBars } from './insertBars.js';
import { loadUniverse } from '../routes/universe.js';
import { publishUniverseUpdated } from '../events/publisher.js';
import { aggPath, MULTIPLIER, TIMESPAN, MAX_RESULTS } from './granularity.js';

type AggregatesResponse = components['schemas']['AggregatesResponse'];
type Bar = NonNullable<AggregatesResponse['results']>[number];

const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = parseInt(process.env['BACKFILL_CONCURRENCY'] ?? '4', 10);
const LOOKBACK_DAYS = parseInt(
  process.env['BACKFILL_LOOKBACK_DAYS'] ?? '730',
  10,
);
const BACKFILL_START_DATE = process.env['BACKFILL_START_DATE'];
// How often to emit a progress line (complete / remaining / ETA) during a run.
const PROGRESS_INTERVAL_MS = parseInt(
  process.env['BACKFILL_PROGRESS_MS'] ?? '30000',
  10,
);
// If a symbol's newest bar is older than this many days after the fetch reached
// `now`, the source has no recent data for it (delisted / depth-capped) and the
// symbol is marked data_status = 'incomplete' rather than 'ok'. The pad absorbs
// the ~15-min feed delay and the longest market-closure run (holiday + weekend).
const STALE_TAIL_DAYS = parseInt(
  process.env['BACKFILL_STALE_TAIL_DAYS'] ?? '7',
  10,
);

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  console[level](
    JSON.stringify({ level, component: 'backfill', msg, ...extra }),
  );
}

function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The earliest date the backfill will fetch to: an explicit BACKFILL_START_DATE
// if set, otherwise LOOKBACK_DAYS before now. Exported so the widen-history
// reset (run-backfill.ts) compares against the exact same window this job uses.
export function resolveStartMs(nowMs: number = Date.now()): number {
  return BACKFILL_START_DATE
    ? new Date(BACKFILL_START_DATE).getTime()
    : nowMs - LOOKBACK_DAYS * DAY_MS;
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function backfillSymbol(redis: Redis, symbol: string): Promise<void> {
  const nowMs = Date.now();
  const startMs = resolveStartMs(nowMs);
  const from = toDateStr(startMs);
  const to = toDateStr(nowMs);

  log('info', 'symbol start', { symbol, from, to });

  // One request over the whole range, followed through next_url. The free tier
  // pages at ~4k bars, so a 2-year 15-min pull is ~8 pages; massiveGetPaged
  // streams each page to insertBars, so memory stays bounded and a crash mid-
  // pagination leaves the already-inserted pages (ON CONFLICT keeps re-runs
  // idempotent).
  let totalBars = 0;
  let newestMs = 0;
  await massiveGetPaged<Bar>(
    redis,
    aggPath(symbol, from, to),
    { sort: 'asc', limit: MAX_RESULTS },
    async (results) => {
      await insertBars(symbol, results);
      totalBars += results.length;
      for (const bar of results) if (bar.t > newestMs) newestMs = bar.t;
      log('info', 'page inserted', { symbol, bars: results.length });
    },
  );

  // Masking guard: a symbol that produced zero bars across every page has no
  // data at the source (wrong ticker, delisted). Do NOT mark it backfilled —
  // leave it backfilled = false so it surfaces honestly and the bootstrap prune
  // can remove it, instead of being silently marked complete-but-empty.
  if (totalBars === 0) {
    log('warn', 'symbol produced no bars — not marking backfilled', { symbol });
    return;
  }

  // Terminal coverage classification: if the newest bar is still well short of
  // `now` after fetching all the way to now, the source has no recent data for
  // this symbol (depth-capped / partially delisted). Flag it 'incomplete' so it
  // is excluded from the playable corpus and the re-arm step stops retrying it.
  const staleCutoffMs = nowMs - STALE_TAIL_DAYS * DAY_MS;
  const dataStatus = newestMs < staleCutoffMs ? 'incomplete' : 'ok';
  await pool.query(
    `UPDATE universe_symbol
        SET backfilled = true, backfilled_at = now(), data_status = $2
      WHERE symbol = $1`,
    [symbol, dataStatus],
  );
  log('info', 'symbol done', { symbol, dataStatus, bars: totalBars });
}

export interface BackfillResult {
  /** Symbols that produced bars and were marked backfilled this run. */
  completed: number;
  /** Symbols whose fetch threw (transient) — left backfilled = false to retry.
   *  Distinct from zero-bar symbols, which are pruning candidates, not retries. */
  failed: string[];
}

export async function runBackfill(redis: Redis): Promise<BackfillResult> {
  const limit = pLimit(CONCURRENCY);

  const { rows } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol
      WHERE backfilled = false AND removed_at IS NULL
      ORDER BY symbol`,
  );

  if (rows.length === 0) {
    log('info', 'nothing to backfill');
    return { completed: 0, failed: [] };
  }

  const total = rows.length;
  log('info', 'starting backfill', {
    total,
    multiplier: MULTIPLIER,
    timespan: TIMESPAN,
    lookbackDays: LOOKBACK_DAYS,
  });

  // Periodically report progress. ETA is extrapolated from the observed
  // completion rate so far (robust to the Massive token-bucket throttle, which
  // dominates throughput) rather than a fixed per-symbol estimate.
  const startedAt = Date.now();
  let completed = 0;
  const failedSymbols: string[] = [];

  const reportProgress = (): void => {
    const processed = completed + failedSymbols.length;
    const remaining = total - processed;
    const elapsedMs = Date.now() - startedAt;
    const etaMs = processed > 0 ? (elapsedMs / processed) * remaining : null;
    log('info', 'progress', {
      completed,
      failed: failedSymbols.length,
      remaining,
      total,
      percent: Math.round((processed / total) * 100),
      elapsed: formatDuration(elapsedMs),
      eta: etaMs === null ? 'estimating…' : formatDuration(etaMs),
    });
  };

  const progressTimer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);
  // Don't let the timer keep the event loop alive on its own.
  progressTimer.unref();

  try {
    await Promise.all(
      rows.map((row) =>
        limit(async () => {
          // Isolate per-symbol failures: a single timeout/error must not abort
          // the whole run. A failed symbol stays backfilled = false and is
          // retried on the next (idempotent) run.
          try {
            await backfillSymbol(redis, row.symbol);
            completed++;
          } catch (err) {
            failedSymbols.push(row.symbol);
            log('error', 'symbol failed — deferring to next run', {
              symbol: row.symbol,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      ),
    );
  } finally {
    clearInterval(progressTimer);
  }

  reportProgress(); // final line

  // Symbols flipped to backfilled — push the refreshed corpus to the WS
  // gateway's `universe` topic (step 4).
  await publishUniverseUpdated(redis, await loadUniverse(false));

  if (failedSymbols.length > 0) {
    log('warn', 'backfill finished with failures — re-run to retry', {
      total,
      completed,
      failed: failedSymbols.length,
      symbols: failedSymbols,
    });
  } else {
    log('info', 'backfill complete', { total });
  }

  return { completed, failed: failedSymbols };
}
