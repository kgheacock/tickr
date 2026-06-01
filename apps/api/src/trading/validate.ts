export type RejectionCode =
  | 'SYMBOL_NOT_TRADEABLE'
  | 'STALE_PRICE'
  | 'VALIDATION'
  | 'INSUFFICIENT_FUNDS'
  | 'INSUFFICIENT_POSITION';

export class TradeRejectionError extends Error {
  constructor(
    public readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
    this.name = 'TradeRejectionError';
  }
}
