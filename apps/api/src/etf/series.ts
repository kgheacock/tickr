/**
 * Synthetic price series computation for ETF baskets.
 *
 * Formula (D3): level(t) = base_value × Σ_i (w_i × close_i(t) / close_i(base_date))
 *   - w_i        = normalized weight for member i (sums to 1.0)
 *   - close_i(t) = carry-forward close of member i at or before t
 *   - base_value = index level (cents) at base_date (e.g. 10000 = $100)
 *
 * OHLC: for a derived index, open = high = low = close (documented on the endpoint).
 * Volume: null.
 */

import { Decimal } from 'decimal.js';
import type { Pool } from 'pg';
import type { PriceBar } from '@tickr/shared-types';

interface EtfRow {
  id: string;
  key: string;
  base_value: number;
  base_date: string; // YYYY-MM-DD
}

interface WeightRow {
  symbol: string;
  weight: string; // NUMERIC from pg
}

interface BarRow {
  symbol: string;
  ts: Date;
  close: number;
}

interface MemberBar {
  tsMs: number;
  close: number;
}

/** Latest bar with tsMs <= targetMs, via binary search over ascending list. */
function barAtOrBefore(bars: MemberBar[], targetMs: number): MemberBar | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found: MemberBar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.tsMs <= targetMs) {
      found = bars[mid]!;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export interface EtfSeriesOptions {
  from: string; // ISO date/datetime; window start
  to: string; // ISO date/datetime; window end
}

/**
 * Computes the synthetic OHLC series for an ETF over the given window.
 *
 * @throws {RangeError} if the ETF key does not exist, a member has no bar at
 *   or before base_date, or the date strings are invalid.
 */
export async function etfSeries(
  pool: Pool,
  key: string,
  opts: EtfSeriesOptions,
): Promise<PriceBar[]> {
  const toMs = Date.parse(opts.to);
  if (Number.isNaN(toMs)) throw new RangeError('invalid `to`');
  const fromMs = Date.parse(opts.from);
  if (Number.isNaN(fromMs)) throw new RangeError('invalid `from`');

  // Load ETF header.
  const { rows: etfRows } = await pool.query<EtfRow>(
    `SELECT id, key, base_value, base_date::text AS base_date FROM etf WHERE key = $1`,
    [key],
  );
  if (etfRows.length === 0) {
    throw new RangeError(`ETF not found: ${key}`);
  }
  const etf = etfRows[0]!;
  // base_date is a DATE stored as "YYYY-MM-DD". Bars on that day are
  // timestamped at 21:00:00Z (end of US trading). Parsing the date string
  // alone gives midnight UTC, which is BEFORE same-day bars.
  // Use start-of-next-day (midnight UTC of base_date+1) as the ceiling so
  // barAtOrBefore correctly finds the last bar on base_date.
  const baseDateStartMs = Date.parse(etf.base_date); // midnight of base_date
  const baseDateCeilingMs = baseDateStartMs + 24 * 60 * 60 * 1000; // midnight of base_date+1

  // Load weights.
  const { rows: weightRows } = await pool.query<WeightRow>(
    `SELECT symbol, weight::text AS weight FROM etf_weight WHERE etf_id = $1`,
    [etf.id],
  );
  if (weightRows.length === 0) {
    throw new RangeError(`ETF ${key} has no members`);
  }
  const members = weightRows.map((w) => w.symbol);

  // Normalize weights to sum to 1.
  const rawSum = weightRows.reduce((s, w) => s.plus(w.weight), new Decimal(0));
  const normalizedWeights = new Map(
    weightRows.map((w) => [w.symbol, new Decimal(w.weight).div(rawSum)]),
  );

  // Load bars from the earliest needed date through `to`.
  // We need bars at/before base_date for base closes, and bars in [from, to]
  // for the series (including carry-forward from just before `from`).
  const queryFromMs = Math.min(baseDateStartMs, fromMs);
  const queryFrom = new Date(queryFromMs).toISOString();
  const queryTo = new Date(toMs).toISOString();

  const { rows: barRows } = await pool.query<BarRow>(
    `SELECT symbol, ts, close
       FROM price_bar
      WHERE symbol = ANY($1)
        AND ts <= $2
        AND ts >= $3
      ORDER BY symbol, ts`,
    [members, queryTo, queryFrom],
  );

  // Group bars by symbol.
  const barsBySymbol = new Map<string, MemberBar[]>();
  for (const r of barRows) {
    const list = barsBySymbol.get(r.symbol) ?? [];
    list.push({ tsMs: r.ts.getTime(), close: r.close });
    barsBySymbol.set(r.symbol, list);
  }

  // Validate: every member must have a bar at/before base_date.
  for (const sym of members) {
    const base = barAtOrBefore(barsBySymbol.get(sym) ?? [], baseDateCeilingMs);
    if (!base) {
      throw new RangeError(
        `ETF ${key}: member ${sym} has no bar at or before base_date ${etf.base_date}`,
      );
    }
  }

  // Build the date-spine: unique timestamps from bars in [from, to].
  const tsSet = new Set<number>();
  for (const r of barRows) {
    const t = r.ts.getTime();
    if (t >= fromMs && t <= toMs) tsSet.add(t);
  }
  const spine = [...tsSet].sort((a, b) => a - b);

  // For each date in the spine, compute the weighted index level.
  return spine.map((tsMs) => {
    let level = new Decimal(0);
    for (const sym of members) {
      const bars = barsBySymbol.get(sym) ?? [];
      const bar = barAtOrBefore(bars, tsMs);
      const baseBar = barAtOrBefore(bars, baseDateCeilingMs)!; // validated above
      const weight = normalizedWeights.get(sym)!;
      if (bar) {
        level = level.plus(
          weight.mul(new Decimal(bar.close).div(baseBar.close)),
        );
      }
    }
    const syntheticClose = level
      .mul(etf.base_value)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();

    return {
      ts: new Date(tsMs).toISOString(),
      open: syntheticClose,
      high: syntheticClose,
      low: syntheticClose,
      close: syntheticClose,
      volume: null,
    };
  });
}
