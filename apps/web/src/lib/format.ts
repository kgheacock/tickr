const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PCT = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const QTY = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 8,
});

/** Format an integer cents value as a USD currency string. */
export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

/** Format a decimal fraction (0.05 = 5%) as a percent string. */
export function formatPercent(fraction: number): string {
  return PCT.format(fraction);
}

/** Format a share quantity (fractional allowed). */
export function formatQuantity(qty: number): string {
  return QTY.format(qty);
}
