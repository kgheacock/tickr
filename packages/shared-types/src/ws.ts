import type {
  PortfolioView,
  Order,
  Fill,
  LeaderboardResponse,
  QuotesResponse,
  ApiError,
} from './index.js';

export type WsTopic =
  | { kind: 'portfolio'; portfolioId: string }
  | { kind: 'leaderboard' }
  | { kind: 'quotes'; symbols: string[] };

export type WsClientMessage =
  | { type: 'subscribe'; topic: WsTopic }
  | { type: 'unsubscribe'; topic: WsTopic };

export type WsServerMessage =
  | { type: 'portfolio.updated'; portfolioId: string; view: PortfolioView }
  | { type: 'order.filled'; portfolioId: string; order: Order; fill: Fill }
  | { type: 'leaderboard.updated'; data: LeaderboardResponse }
  | { type: 'quotes.updated'; asOf: string; quotes: QuotesResponse['quotes'] }
  | { type: 'error'; error: ApiError['error'] };
