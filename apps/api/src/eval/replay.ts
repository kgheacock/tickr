import { Decimal } from 'decimal.js';
import type {
  EvaluateRequest,
  EvaluateResponse,
  EvaluatedOrder,
} from '@tickr/shared-types';
import { pool } from '../db/pool.js';
import {
  computeCostCents,
  computeNewAvgCost,
  subtractQuantity,
} from '../trading/money.js';
import { isEtfHandle, normalizeHandle, etfKey } from '../etf/resolve.js';
import { etfSeries } from '../etf/series.js';

/**
 * Staleness window for point-in-time fills. Mirrors the (now-removed) live
 * engine's 5-calendar-day rule: a fill whose nearest prior bar is older than
 * this relative to the order's `at` is rejected as STALE_PRICE.
 */
export const STALE_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;

interface Bar {
  tsMs: number;
  close: number;
}

interface Holding {
  qty: Decimal;
  avgCost: number;
}

/** Latest bar with `tsMs <= atMs`, via binary search over the ascending list. */
function barAtOrBefore(bars: Bar[], atMs: number): Bar | null {
  let lo = 0;
  let hi = bars.length - 1;
  let found: Bar | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.tsMs <= atMs) {
      found = bars[mid]!;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Value the held positions at the point-in-time close for each symbol. */
function equityAt(
  cash: number,
  holdings: Map<string, Holding>,
  barsBySymbol: Map<string, Bar[]>,
  atMs: number,
): number {
  let equity = cash;
  for (const [symbol, h] of holdings) {
    const bar = barAtOrBefore(barsBySymbol.get(symbol) ?? [], atMs);
    if (bar) equity += computeCostCents(h.qty.toFixed(8), bar.close);
  }
  return equity;
}

/**
 * Stateless returns evaluation (D5). Replays a series of orders against
 * historical `price_bar` data, filling each at the most recent close at or
 * before the order's `at`. Writes nothing to the DB.
 */
export async function replay(req: EvaluateRequest): Promise<EvaluateResponse> {
  // Normalize handles: ETF handles → "etf:<key>"; real symbols → uppercase.
  const symbols = [
    ...new Set(req.orders.map((o) => normalizeHandle(o.symbol))),
  ];

  const etfHandles = symbols.filter(isEtfHandle);
  const realSymbols = symbols.filter((s) => !isEtfHandle(s));

  const barsBySymbol = new Map<string, Bar[]>();

  // Load real symbol bars (full history for point-in-time fill).
  if (realSymbols.length > 0) {
    const { rows } = await pool.query<{
      symbol: string;
      ts: Date;
      close: number;
    }>(
      `SELECT symbol, ts, close
         FROM price_bar
        WHERE symbol = ANY($1)
        ORDER BY symbol, ts`,
      [realSymbols],
    );
    for (const r of rows) {
      const list = barsBySymbol.get(r.symbol) ?? [];
      list.push({ tsMs: r.ts.getTime(), close: r.close });
      barsBySymbol.set(r.symbol, list);
    }
  }

  // Load ETF synthetic series for each handle.
  // Use the full history (from epoch to now) so the point-in-time fill works.
  if (etfHandles.length > 0) {
    const earliest = '1970-01-01T00:00:00Z';
    const latest = new Date().toISOString();
    for (const handle of etfHandles) {
      try {
        const bars = await etfSeries(pool, etfKey(handle), {
          from: earliest,
          to: latest,
        });
        barsBySymbol.set(
          handle,
          bars.map((b) => ({ tsMs: Date.parse(b.ts), close: b.close })),
        );
      } catch {
        // ETF not found — the orders using this handle will be rejected as
        // SYMBOL_NOT_TRADEABLE (barsBySymbol has no entry for the handle).
      }
    }
  }

  // Process in execution (`at`) order; tie-break on original index for stability.
  const indexed = req.orders.map((o, i) => ({ o, i }));
  indexed.sort((a, b) => Date.parse(a.o.at) - Date.parse(b.o.at) || a.i - b.i);

  let cash = req.startingCash;
  const holdings = new Map<string, Holding>();
  const orders: EvaluatedOrder[] = [];
  const equityCurve: EvaluateResponse['equityCurve'] = [];

  for (const { o } of indexed) {
    const symbol = normalizeHandle(o.symbol);
    const atMs = Date.parse(o.at);
    const bars = barsBySymbol.get(symbol) ?? [];
    const bar = barAtOrBefore(bars, atMs);

    let status: 'filled' | 'rejected' = 'filled';
    let rejectReason: string | null = null;
    let fillPrice: number | null = null;

    if (!bar) {
      status = 'rejected';
      rejectReason = 'SYMBOL_NOT_TRADEABLE';
    } else if (atMs - bar.tsMs > STALE_WINDOW_MS) {
      status = 'rejected';
      rejectReason = 'STALE_PRICE';
    } else {
      const price = bar.close;
      const cost = computeCostCents(o.quantity, price);
      if (o.side === 'buy') {
        if (cost > cash) {
          status = 'rejected';
          rejectReason = 'INSUFFICIENT_FUNDS';
        } else {
          fillPrice = price;
          const existing = holdings.get(symbol);
          if (existing) {
            const avgCost = computeNewAvgCost(
              existing.qty.toFixed(8),
              existing.avgCost,
              o.quantity,
              price,
            );
            holdings.set(symbol, {
              qty: existing.qty.plus(o.quantity),
              avgCost,
            });
          } else {
            holdings.set(symbol, {
              qty: new Decimal(o.quantity),
              avgCost: price,
            });
          }
          cash -= cost;
        }
      } else {
        const held = holdings.get(symbol)?.qty ?? new Decimal(0);
        if (held.lessThan(o.quantity)) {
          status = 'rejected';
          rejectReason = 'INSUFFICIENT_POSITION';
        } else {
          fillPrice = price;
          const newQty = subtractQuantity(held.toFixed(8), o.quantity);
          if (newQty.isZero()) {
            holdings.delete(symbol);
          } else {
            holdings.set(symbol, {
              qty: newQty,
              avgCost: holdings.get(symbol)!.avgCost,
            });
          }
          cash += cost;
        }
      }
    }

    orders.push({
      symbol,
      side: o.side,
      quantity: o.quantity,
      at: o.at,
      fillPrice,
      status,
      rejectReason,
    });
    equityCurve.push({
      ts: o.at,
      equity: equityAt(cash, holdings, barsBySymbol, atMs),
    });
  }

  // Final positions valued at each symbol's latest available close.
  const finalPositions: EvaluateResponse['finalPositions'] = [];
  let positionsValue = 0;
  let valuable = true;
  for (const [symbol, h] of holdings) {
    finalPositions.push({
      symbol,
      quantity: Number(h.qty.toFixed(8)),
      avgCost: h.avgCost,
    });
    const bars = barsBySymbol.get(symbol) ?? [];
    const last = bars[bars.length - 1];
    if (last) positionsValue += computeCostCents(h.qty.toFixed(8), last.close);
    else valuable = false;
  }
  finalPositions.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const finalEquity = valuable ? cash + positionsValue : null;
  const totalReturnPct =
    finalEquity === null || req.startingCash === 0
      ? null
      : ((finalEquity - req.startingCash) / req.startingCash) * 100;

  return {
    orders,
    finalCash: cash,
    finalPositions,
    finalEquity,
    totalReturnPct,
    equityCurve,
  };
}
