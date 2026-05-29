export type { paths, components, operations } from './openapi.gen.js';
export type { WsTopic, WsClientMessage, WsServerMessage } from './ws.js';

import type { components } from './openapi.gen.js';

// --- Enums ---
export type OrderSide = components['schemas']['OrderSide'];
export type OrderType = components['schemas']['OrderType'];
export type OrderStatus = components['schemas']['OrderStatus'];

// --- Core entities ---
export type User = components['schemas']['User'];
export type Identity = components['schemas']['Identity'];
export type Portfolio = components['schemas']['Portfolio'];
export type Order = components['schemas']['Order'];
export type Fill = components['schemas']['Fill'];
export type ValuationSnapshot = components['schemas']['ValuationSnapshot'];
export type PositionView = components['schemas']['PositionView'];
export type LeaderboardRowItem = components['schemas']['LeaderboardRowItem'];
export type QuoteEntry = components['schemas']['QuoteEntry'];
export type SymbolItem = components['schemas']['SymbolItem'];

// --- Response types ---
export type ApiError = components['schemas']['ApiError'];
export type MeResponse = components['schemas']['MeResponse'];
export type PortfolioView = components['schemas']['PortfolioView'];
export type CreateOrderResponse = components['schemas']['CreateOrderResponse'];
export type OrdersPage = components['schemas']['OrdersPage'];
export type HistoryPage = components['schemas']['HistoryPage'];
export type LeaderboardResponse = components['schemas']['LeaderboardResponse'];
export type QuotesResponse = components['schemas']['QuotesResponse'];
export type SymbolsResponse = components['schemas']['SymbolsResponse'];
export type OpsResponse = components['schemas']['OpsResponse'];

// --- Request types ---
export type CreateOrderRequest = components['schemas']['CreateOrderRequest'];
export type UpsertUniverseRequest =
  components['schemas']['UpsertUniverseRequest'];
export type BackfillRequest = components['schemas']['BackfillRequest'];
