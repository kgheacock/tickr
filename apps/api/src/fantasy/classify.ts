/**
 * Fantasy Street item 02 — player (stock) classifier.
 *
 * Reads price_bar for every backfilled symbol, computes trailing returns and
 * volatility, and assigns each stock to the slot families (groups) it qualifies
 * for, upserting fs_player_classification. Pure price-derived classification —
 * there is NO fundamentals feed, so sector / market-cap tier (which would
 * sharpen Anchor and Value) is an OPEN DATA ITEM; Value is a price-only proxy
 * (lowest trailing 12m return among non-Growth) until that lands.
 *
 * Idempotent and re-runnable: a second run over unchanged price data writes the
 * same (group, eligible, metrics) rows. Scheduled weekly in the worker role and
 * runnable on demand.
 */
import type { Pool } from 'pg';
import type { PlayerGroup } from '@tickr/shared-types';

// Trailing windows, in trading-day bar counts (~21 bars/month).
const BARS_3M = 63;
const BARS_12M = 252;
const SIGMA_WINDOW = 63; // ~90 calendar days of daily returns

export interface SymbolMetrics {
  symbol: string;
  ret3mPct: number | null;
  ret12mPct: number | null;
  sigma: number | null;
  avgVolume: number | null;
}

interface BarRow {
  close: number;
  volume: number | null;
}

/** numpy-style linear-interpolation percentile over a sorted-asc copy. */
export function percentile(values: number[], p: number): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0]!;
  const rank = p * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return xs[lo]! + frac * (xs[hi]! - xs[lo]!);
}

/** Returns from the first close that is `back` bars before the last one. */
function trailingReturnPct(closes: number[], back: number): number | null {
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1]!;
  const idx = Math.max(0, closes.length - 1 - back);
  const base = closes[idx]!;
  if (base === 0) return null;
  return ((last - base) / base) * 100;
}

/** Population stddev of daily simple returns over the trailing window. */
function trailingSigma(closes: number[], window: number): number | null {
  if (closes.length < 3) return null;
  const start = Math.max(1, closes.length - window);
  const rets: number[] = [];
  for (let i = start; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev !== 0) rets.push((closes[i]! - prev) / prev);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

export function metricsFor(symbol: string, bars: BarRow[]): SymbolMetrics {
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume).filter((v): v is number => v != null);
  return {
    symbol,
    ret3mPct: trailingReturnPct(closes, BARS_3M),
    ret12mPct: trailingReturnPct(closes, BARS_12M),
    sigma: trailingSigma(closes, SIGMA_WINDOW),
    avgVolume: vols.length
      ? vols.reduce((s, v) => s + v, 0) / vols.length
      : null,
  };
}

/**
 * Assign the eligible groups for each symbol from the cross-sectional metric
 * distribution. Defense and Wildcard are universal; the rest are quartile-based.
 */
export function assignGroups(
  metrics: SymbolMetrics[],
): Map<string, PlayerGroup[]> {
  const ret12 = metrics
    .map((m) => m.ret12mPct)
    .filter((v): v is number => v != null);
  const ret3 = metrics
    .map((m) => m.ret3mPct)
    .filter((v): v is number => v != null);
  const sig = metrics.map((m) => m.sigma).filter((v): v is number => v != null);
  const vol = metrics
    .map((m) => m.avgVolume)
    .filter((v): v is number => v != null);

  const growthCut = percentile(ret12, 0.75);
  const valueCut = percentile(ret12, 0.25);
  const momentumCut = percentile(ret3, 0.75);
  const lowVolCut = percentile(sig, 0.25);
  const liquidCut = percentile(vol, 0.75);

  const out = new Map<string, PlayerGroup[]>();
  for (const m of metrics) {
    const groups: PlayerGroup[] = ['defense', 'wildcard']; // universal

    const isGrowth =
      growthCut != null && m.ret12mPct != null && m.ret12mPct >= growthCut;
    if (isGrowth) groups.push('growth');

    if (
      momentumCut != null &&
      m.ret3mPct != null &&
      m.ret3mPct >= momentumCut
    ) {
      groups.push('momentum');
    }

    // Value: lowest trailing return among non-Growth (price-only proxy).
    if (
      !isGrowth &&
      valueCut != null &&
      m.ret12mPct != null &&
      m.ret12mPct <= valueCut
    ) {
      groups.push('value');
    }

    // Anchor: low volatility, and (when volume is known) high liquidity.
    // Null-safe: a symbol with no volume data is judged on low-σ alone.
    const lowVol = lowVolCut != null && m.sigma != null && m.sigma <= lowVolCut;
    const liquid =
      m.avgVolume == null || liquidCut == null || m.avgVolume >= liquidCut;
    if (lowVol && liquid) groups.push('anchor');

    out.set(m.symbol, groups);
  }
  return out;
}

/**
 * Recompute classification for every backfilled symbol and replace the stored
 * rows in one transaction. Returns the number of symbols classified.
 */
export async function runClassifier(pool: Pool): Promise<number> {
  const { rows: symRows } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol
      WHERE removed_at IS NULL
        AND backfilled = true
        AND data_status IS DISTINCT FROM 'incomplete'
      ORDER BY symbol`,
  );
  if (symRows.length === 0) return 0;

  const metrics: SymbolMetrics[] = [];
  for (const { symbol } of symRows) {
    const { rows } = await pool.query<BarRow>(
      `SELECT close, volume FROM price_bar WHERE symbol = $1 ORDER BY ts ASC`,
      [symbol],
    );
    metrics.push(metricsFor(symbol, rows));
  }

  const groupsBySymbol = assignGroups(metrics);
  const metricsBySymbol = new Map(metrics.map((m) => [m.symbol, m]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const symbols = [...groupsBySymbol.keys()];
    // Replace this batch's rows wholesale → idempotent on re-run.
    await client.query(
      `DELETE FROM fs_player_classification WHERE symbol = ANY($1::text[])`,
      [symbols],
    );
    for (const [symbol, groups] of groupsBySymbol) {
      const m = metricsBySymbol.get(symbol)!;
      const metricsJson = JSON.stringify({
        ret3mPct: m.ret3mPct,
        ret12mPct: m.ret12mPct,
        sigma: m.sigma,
        avgVolume: m.avgVolume,
      });
      for (const group of groups) {
        await client.query(
          `INSERT INTO fs_player_classification (symbol, "group", eligible, metrics)
           VALUES ($1, $2, true, $3::jsonb)`,
          [symbol, group, metricsJson],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return symRows.length;
}
