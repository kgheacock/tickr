import { Decimal } from 'decimal.js';

// Quantity throughout the system is NUMERIC(20,8) — pg returns it as a string.
// All quantity arithmetic uses Decimal to avoid float drift.
// Cent values (cash, prices, avg_cost) are plain JS integers.

export function computeCostCents(
  quantity: number | string,
  pricePerShareCents: number,
): number {
  return new Decimal(quantity)
    .times(pricePerShareCents)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function computeNewAvgCost(
  existingQtyStr: string,
  existingAvgCost: number,
  addedQty: number | string,
  addedPriceCents: number,
): number {
  const existing = new Decimal(existingQtyStr);
  const added = new Decimal(addedQty);
  const total = existing.plus(added);
  return existing
    .times(existingAvgCost)
    .plus(added.times(addedPriceCents))
    .dividedBy(total)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
}

export function subtractQuantity(
  existingStr: string,
  delta: number | string,
): Decimal {
  return new Decimal(existingStr).minus(new Decimal(delta));
}
