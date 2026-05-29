// Monetary values are stored as BIGINT cents and returned to JS as number.
// Number.MAX_SAFE_INTEGER (~9.007e15) >> $90 trillion in cents, so there is
// no precision risk for any realistic trading amount. pool.ts installs this
// conversion globally via pg.types.setTypeParser(20, Number).
export type Cents = number;

// NUMERIC(20,8) columns (quantity, volume) are returned by pg as string to
// preserve their 8 decimal places. Callers must not coerce these to number
// without rounding intentionally.
export type Quantity = string;
