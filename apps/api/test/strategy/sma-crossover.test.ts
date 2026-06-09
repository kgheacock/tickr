import { describe, it, expect } from 'vitest';
import {
  simpleMovingAverage,
  runSmaCrossover,
  buyAndHoldCurve,
  totalReturnPct,
  maxDrawdownPct,
  type DailyClose,
} from '../../src/strategy/sma-crossover.js';

function series(closes: number[]): DailyClose[] {
  // One bar per day starting 2024-01-01, at 21:00Z (US close), like price_bar.
  return closes.map((close, i) => {
    const day = String(i + 1).padStart(2, '0');
    return { ts: `2024-01-${day}T21:00:00Z`, close };
  });
}

describe('simpleMovingAverage', () => {
  it('is null until the window is filled, then the trailing mean', () => {
    expect(simpleMovingAverage([10, 20, 30, 40], 2)).toEqual([
      null,
      15,
      25,
      35,
    ]);
  });
});

describe('runSmaCrossover', () => {
  // A rise-then-fall series: short(2) crosses above long(3) on the way up
  // (buy at the peak price 20000) and below on the way down (sell at 10000).
  const closes = [
    10000, 10000, 10000, 20000, 20000, 20000, 10000, 10000, 10000,
  ];
  const startingCash = 1_000_000; // $10,000

  it('buys the whole balance on the up-cross and sells it all on the down-cross', () => {
    const { orders, equityCurve } = runSmaCrossover(
      series(closes),
      'etf:test',
      startingCash,
      { shortWindow: 2, longWindow: 3 },
    );

    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({
      symbol: 'etf:test',
      side: 'buy',
      quantity: 50, // floor(1_000_000 / 20_000)
      at: '2024-01-04T21:00:00Z',
    });
    expect(orders[1]).toMatchObject({
      side: 'sell',
      quantity: 50,
      at: '2024-01-07T21:00:00Z',
    });

    // One equity point per day; starts flat at startingCash before any trade.
    expect(equityCurve).toHaveLength(closes.length);
    expect(equityCurve[0]!.equity).toBe(startingCash);
    // Bought at 20000, sold at 10000 → ends holding $5,000 in cash.
    expect(equityCurve[equityCurve.length - 1]!.equity).toBe(500_000);
  });

  it('never floors a buy that cannot be afforded at the fill price', () => {
    const { orders } = runSmaCrossover(series(closes), 'etf:test', 15_000, {
      shortWindow: 2,
      longWindow: 3,
    });
    // $150 < one share at 20000 cents → no affordable buy, no orders.
    expect(orders).toHaveLength(0);
  });
});

describe('buyAndHoldCurve / stats', () => {
  it('rebases a flat-ending series to a 0% return', () => {
    const curve = buyAndHoldCurve(series([10000, 20000, 10000]), 1_000_000);
    expect(curve.map((p) => p.equity)).toEqual([
      1_000_000, 2_000_000, 1_000_000,
    ]);
    expect(totalReturnPct(curve, 1_000_000)).toBe(0);
  });

  it('measures total return and max drawdown', () => {
    const curve = buyAndHoldCurve(series([10000, 20000, 5000]), 1_000_000);
    // peak 2,000,000 → trough 500,000 → 75% drawdown; final return -50%.
    expect(totalReturnPct(curve, 1_000_000)).toBe(-50);
    expect(maxDrawdownPct(curve)).toBe(75);
  });

  it('returns null stats for an empty curve', () => {
    expect(totalReturnPct([], 1_000_000)).toBeNull();
    expect(maxDrawdownPct([])).toBeNull();
  });
});
