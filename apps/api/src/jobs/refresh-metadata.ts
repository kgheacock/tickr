import type { Redis } from 'ioredis';
import pLimit from 'p-limit';
import { pool } from '../db/pool.js';
import { massiveGet, massiveGetBytes } from '../massive/client.js';
import { toMassiveTicker } from './granularity.js';
import { jobLogger } from '../log/logger.js';

const baseLog = jobLogger('metadata');

const DAY_MS = 24 * 60 * 60 * 1000;
const CONCURRENCY = parseInt(process.env['METADATA_CONCURRENCY'] ?? '4', 10);
// Age-out: an artifact older than this is re-fetched. The shared Massive bucket
// (~5 req/min) makes a full run long, so the default keeps routine re-runs cheap
// — only missing/stale rows are touched. METADATA_REFRESH_ALL forces every row.
const TTL_DAYS = parseInt(process.env['METADATA_TTL_DAYS'] ?? '30', 10);
const FORCE_ALL = process.env['METADATA_REFRESH_ALL'] === 'true';
// Icons roughly double the request count (one extra download per symbol). On by
// default — "keep everything downloaded" — but switchable for a faster run.
const DOWNLOAD_ICONS = process.env['METADATA_DOWNLOAD_ICONS'] !== 'false';
const PROGRESS_INTERVAL_MS = parseInt(
  process.env['METADATA_PROGRESS_MS'] ?? '30000',
  10,
);

// Shape of the bits of GET /v3/reference/tickers/{ticker} we break out into
// columns. Everything is optional — across 500 symbols some fields are absent.
interface Branding {
  logo_url?: string;
  icon_url?: string;
}
interface TickerDetails {
  ticker?: string;
  name?: string;
  primary_exchange?: string;
  type?: string;
  market_cap?: number;
  sic_code?: string;
  sic_description?: string;
  homepage_url?: string;
  list_date?: string;
  total_employees?: number;
  description?: string;
  branding?: Branding;
}
interface DetailsResponse {
  results?: TickerDetails;
}

interface CandidateRow {
  symbol: string;
  meta_fetched_at: Date | null;
  logo_fetched_at: Date | null;
  icon_fetched_at: Date | null;
}

function log(
  level: 'info' | 'warn' | 'error',
  msg: string,
  extra?: object,
): void {
  baseLog[level](extra ?? {}, msg);
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

function isStale(ts: Date | null, cutoff: Date): boolean {
  return FORCE_ALL || ts === null || ts.getTime() < cutoff.getTime();
}

async function upsertMetadata(
  symbol: string,
  massiveTicker: string,
  d: TickerDetails,
): Promise<void> {
  await pool.query(
    `INSERT INTO symbol_metadata (
        symbol, massive_ticker, name, primary_exchange, type, market_cap,
        sic_code, sic_description, homepage_url, list_date, total_employees,
        description, raw, fetched_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
     ON CONFLICT (symbol) DO UPDATE SET
        massive_ticker   = EXCLUDED.massive_ticker,
        name             = EXCLUDED.name,
        primary_exchange = EXCLUDED.primary_exchange,
        type             = EXCLUDED.type,
        market_cap       = EXCLUDED.market_cap,
        sic_code         = EXCLUDED.sic_code,
        sic_description  = EXCLUDED.sic_description,
        homepage_url     = EXCLUDED.homepage_url,
        list_date        = EXCLUDED.list_date,
        total_employees  = EXCLUDED.total_employees,
        description      = EXCLUDED.description,
        raw              = EXCLUDED.raw,
        fetched_at       = now(),
        updated_at       = now()`,
    [
      symbol,
      massiveTicker,
      d.name ?? null,
      d.primary_exchange ?? null,
      d.type ?? null,
      d.market_cap ?? null,
      d.sic_code ?? null,
      d.sic_description ?? null,
      d.homepage_url ?? null,
      d.list_date ?? null,
      d.total_employees ?? null,
      d.description ?? null,
      JSON.stringify(d),
    ],
  );
}

// Upsert one branding image (logo or icon) into its own columns, leaving the
// other image untouched — so a logo refresh never clobbers a previously stored
// icon, and a partial failure re-arms only the missing piece on the next run.
async function upsertBrandingImage(
  symbol: string,
  kind: 'logo' | 'icon',
  bytes: Buffer,
  contentType: string,
  sourceUrl: string,
): Promise<void> {
  const cols = `${kind}_bytes, ${kind}_content_type, ${kind}_source_url, ${kind}_fetched_at`;
  await pool.query(
    `INSERT INTO symbol_branding (symbol, ${cols}, updated_at)
     VALUES ($1, $2, $3, $4, now(), now())
     ON CONFLICT (symbol) DO UPDATE SET
        ${kind}_bytes        = EXCLUDED.${kind}_bytes,
        ${kind}_content_type = EXCLUDED.${kind}_content_type,
        ${kind}_source_url   = EXCLUDED.${kind}_source_url,
        ${kind}_fetched_at   = now(),
        updated_at           = now()`,
    [symbol, bytes, contentType, sourceUrl],
  );
}

// Record that an image was checked but the source offers none, by stamping its
// fetch date with NULL bytes left untouched. This is what makes the refresh
// reach a quiet steady state: a symbol with no logo/icon is not re-selected
// every run forever — it ages out like any other artifact and is only re-checked
// after the TTL (in case branding appears upstream later).
async function markImageAbsent(
  symbol: string,
  kind: 'logo' | 'icon',
): Promise<void> {
  await pool.query(
    `INSERT INTO symbol_branding (symbol, ${kind}_fetched_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (symbol) DO UPDATE SET
        ${kind}_fetched_at = now(),
        updated_at         = now()`,
    [symbol],
  );
}

// Download one branding image and store it. Three outcomes, each distinct so the
// next run does the right thing:
//   * URL absent      → stamp "checked, none available" (won't re-select < TTL).
//   * download failed → leave the fetch date as-is so the symbol re-arms next
//                       run; metadata and the other image that succeeded stay.
//   * download ok      → store bytes + content type + stamp.
async function refreshImage(
  redis: Redis,
  symbol: string,
  kind: 'logo' | 'icon',
  url: string | undefined,
): Promise<boolean> {
  if (!url) {
    await markImageAbsent(symbol, kind);
    return false;
  }
  try {
    const { bytes, contentType } = await massiveGetBytes(redis, url);
    await upsertBrandingImage(symbol, kind, bytes, contentType, url);
    return true;
  } catch (err) {
    log('warn', 'image download failed — will retry next run', {
      symbol,
      kind,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

interface SymbolOutcome {
  logo: boolean;
  icon: boolean;
}

// Fetch reference details (always — they carry the current image URLs), upsert
// metadata, then download whichever images are missing/stale. Throwing here
// (e.g. a 404 for an unknown ticker) defers the whole symbol to the next run.
async function refreshSymbol(
  redis: Redis,
  row: CandidateRow,
  cutoff: Date,
): Promise<SymbolOutcome> {
  const massiveTicker = toMassiveTicker(row.symbol);
  const body = await massiveGet<DetailsResponse>(
    redis,
    `/v3/reference/tickers/${massiveTicker}`,
  );
  const details = body.results;
  if (!details) {
    log('warn', 'no reference results — skipping', { symbol: row.symbol });
    return { logo: false, icon: false };
  }

  await upsertMetadata(row.symbol, massiveTicker, details);

  const branding = details.branding;
  const outcome: SymbolOutcome = { logo: false, icon: false };

  if (isStale(row.logo_fetched_at, cutoff)) {
    outcome.logo = await refreshImage(
      redis,
      row.symbol,
      'logo',
      branding?.logo_url,
    );
  }
  if (DOWNLOAD_ICONS && isStale(row.icon_fetched_at, cutoff)) {
    outcome.icon = await refreshImage(
      redis,
      row.symbol,
      'icon',
      branding?.icon_url,
    );
  }
  return outcome;
}

async function selectCandidates(cutoff: Date): Promise<CandidateRow[]> {
  // A symbol is a candidate when metadata or any tracked image is missing or
  // older than the cutoff. The icon clause is included only when icons are being
  // downloaded — otherwise their perpetually-NULL fetch date would select every
  // symbol forever. FORCE_ALL bypasses the freshness test entirely.
  const iconClause = DOWNLOAD_ICONS
    ? `OR b.icon_fetched_at IS NULL OR b.icon_fetched_at < $1`
    : '';
  const freshness = FORCE_ALL
    ? 'TRUE'
    : `m.fetched_at IS NULL OR m.fetched_at < $1
       OR b.logo_fetched_at IS NULL OR b.logo_fetched_at < $1
       ${iconClause}`;
  const { rows } = await pool.query<CandidateRow>(
    `SELECT u.symbol,
            m.fetched_at  AS meta_fetched_at,
            b.logo_fetched_at,
            b.icon_fetched_at
       FROM universe_symbol u
       LEFT JOIN symbol_metadata m ON m.symbol = u.symbol
       LEFT JOIN symbol_branding  b ON b.symbol = u.symbol
      WHERE u.removed_at IS NULL AND (${freshness})
      ORDER BY u.symbol`,
    FORCE_ALL ? [] : [cutoff],
  );
  return rows;
}

export interface MetadataRefreshResult {
  total: number;
  metadata: number;
  logos: number;
  icons: number;
  failed: string[];
}

export async function runMetadataRefresh(
  redis: Redis,
): Promise<MetadataRefreshResult> {
  const cutoff = new Date(Date.now() - TTL_DAYS * DAY_MS);
  const rows = await selectCandidates(cutoff);

  if (rows.length === 0) {
    log('info', 'metadata up to date — nothing to refresh');
    return { total: 0, metadata: 0, logos: 0, icons: 0, failed: [] };
  }

  const total = rows.length;
  log('info', 'starting metadata refresh', {
    total,
    ttlDays: TTL_DAYS,
    forceAll: FORCE_ALL,
    downloadIcons: DOWNLOAD_ICONS,
  });

  const startedAt = Date.now();
  let metadata = 0;
  let logos = 0;
  let icons = 0;
  const failed: string[] = [];

  const reportProgress = (): void => {
    const processed = metadata + failed.length;
    const remaining = total - processed;
    const elapsedMs = Date.now() - startedAt;
    const etaMs = processed > 0 ? (elapsedMs / processed) * remaining : null;
    log('info', 'progress', {
      metadata,
      logos,
      icons,
      failed: failed.length,
      remaining,
      total,
      percent: Math.round((processed / total) * 100),
      elapsed: formatDuration(elapsedMs),
      eta: etaMs === null ? 'estimating…' : formatDuration(etaMs),
    });
  };

  const progressTimer = setInterval(reportProgress, PROGRESS_INTERVAL_MS);
  progressTimer.unref();

  const limit = pLimit(CONCURRENCY);
  try {
    await Promise.all(
      rows.map((row) =>
        limit(async () => {
          try {
            const outcome = await refreshSymbol(redis, row, cutoff);
            metadata++;
            if (outcome.logo) logos++;
            if (outcome.icon) icons++;
          } catch (err) {
            failed.push(row.symbol);
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

  if (failed.length > 0) {
    log('warn', 'metadata refresh finished with failures — re-run to retry', {
      total,
      metadata,
      logos,
      icons,
      failed: failed.length,
      symbols: failed,
    });
  } else {
    log('info', 'metadata refresh complete', { total, metadata, logos, icons });
  }

  return { total, metadata, logos, icons, failed };
}
