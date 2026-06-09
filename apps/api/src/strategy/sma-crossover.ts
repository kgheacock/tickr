/**
 * Built-in SMA-crossover trading strategy (item 18).
 *
 * The canonical "basic algorithmic trading strategy": compute a short and a
 * long simple moving average over an ETF's synthetic daily closes; go fully
 * invested when the short SMA crosses *above* the long, go fully to cash when
 * it crosses *below*.
 *
 * This module is pure (no DB, no I/O) so it is cheaply unit-tested and is the
 * natural home for the future "user-defined algorithm" work. The route layer
 * feeds it an ETF series (from etfSeries) and posts the resulting order series
 * to POST /evaluate for the faithful point-in-time fills.
 *
 * The strategy `equityCurve` is computed *daily* here (one point per close) so
 * the client can plot a dense line — /evaluate only emits one equity point per
 * order, which is too sparse for a chart and gives no buy-and-hold baseline.
 */

import type { EvaluateOrder, EquityPoint } from '@tickr/shared-types';

export const DEFAULT_SHORT_WINDOW = 20;
export const DEFAULT_LONG_WINDOW = 50;

export interface SmaParams {
  shortWindow: number;
  longWindow: number;
}

/** One daily close on the synthetic series. `close` is in integer cents. */
export interface DailyClose {
  ts: string;
  close: number;
}

export interface SmaBacktest {
  /** Order series to replay through /evaluate (buy/sell whole balance). */
  orders: EvaluateOrder[];
  /** Dense daily equity curve of the strategy (cents). */
  equityCurve: EquityPoint[];
}

/**
 * Trailing simple moving average. `out[i]` is the mean of the `window` closes
 * ending at `i`, or `null` until there are enough samples.
 */
export function simpleMovingAverage(
  closes: number[],
  window: number,
): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= window) sum -= closes[i - window]!;
    out.push(i >= window - 1 ? sum / window : null);
  }
  return out;
}

/**
 * Simulate the SMA-crossover strategy over a daily series, producing both the
 * order series and the daily equity curve. Cash is walked through the same
 * synthetic closes the replay engine fills at, and buy quantities are floored
 * to whole shares affordable at the close — so the orders never trip
 * INSUFFICIENT_FUNDS when replayed.
 */
export function runSmaCrossover(
  series: DailyClose[],
  etfHandle: string,
  startingCash: number,
  params: SmaParams,
): SmaBacktest {
  const closes = series.map((d) => d.close);
  const shortSma = simpleMovingAverage(closes, params.shortWindow);
  const longSma = simpleMovingAverage(closes, params.longWindow);

  let cash = startingCash;
  let qty = 0; // whole shares held
  let invested = false;
  const orders: EvaluateOrder[] = [];
  const equityCurve: EquityPoint[] = [];

  for (let i = 0; i < series.length; i++) {
    const { ts, close } = series[i]!;
    const sPrev = shortSma[i - 1];
    const lPrev = longSma[i - 1];
    const sCur = shortSma[i];
    const lCur = longSma[i];

    if (sPrev != null && lPrev != null && sCur != null && lCur != null) {
      const crossedUp = sPrev <= lPrev && sCur > lCur;
      const crossedDown = sPrev >= lPrev && sCur < lCur;

      if (crossedUp && !invested) {
        const buyQty = close > 0 ? Math.floor(cash / close) : 0;
        if (buyQty > 0) {
          orders.push({
            symbol: etfHandle,
            side: 'buy',
            quantity: buyQty,
            at: ts,
          });
          cash -= buyQty * close;
          qty += buyQty;
          invested = true;
        }
      } else if (crossedDown && invested) {
        if (qty > 0) {
          orders.push({
            symbol: etfHandle,
            side: 'sell',
            quantity: qty,
            at: ts,
          });
          cash += qty * close;
          qty = 0;
        }
        invested = false;
      }
    }

    equityCurve.push({ ts, equity: Math.round(cash + qty * close) });
  }

  return { orders, equityCurve };
}

/**
 * Buy-and-hold baseline: invest the whole balance on day one and hold. Rebased
 * by price ratio so it is a dense daily curve to overlay against the strategy.
 */
export function buyAndHoldCurve(
  series: DailyClose[],
  startingCash: number,
): EquityPoint[] {
  if (series.length === 0) return [];
  const first = series[0]!.close;
  return series.map((d) => ({
    ts: d.ts,
    equity:
      first === 0 ? startingCash : Math.round((startingCash * d.close) / first),
  }));
}

/** Total return % of an equity curve vs the starting cash. */
export function totalReturnPct(
  curve: EquityPoint[],
  startingCash: number,
): number | null {
  if (curve.length === 0 || startingCash === 0) return null;
  const last = curve[curve.length - 1]!.equity;
  return ((last - startingCash) / startingCash) * 100;
}

/** Largest peak-to-trough drawdown of an equity curve, as a positive %. */
export function maxDrawdownPct(curve: EquityPoint[]): number | null {
  if (curve.length === 0) return null;
  let peak = curve[0]!.equity;
  let maxDd = 0;
  for (const p of curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) {
      const dd = ((peak - p.equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}
