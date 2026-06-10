export type { paths, components, operations } from './openapi.gen.js';
export type { WsTopic, WsClientMessage, WsServerMessage } from './ws.js';

// --- Fantasy Street (epic v2) ---
export type {
  RosterConfig,
  LeagueMember,
  LeagueView,
  LeagueSummary,
  LeagueListResponse,
  LeagueMembership,
  Invite,
  CreateLeagueRequest,
  UpdateLeagueRequest,
  CreateInviteRequest,
  JoinLeagueRequest,
  LeagueStatus,
  JoinPolicy,
  MemberRole,
} from './fantasy.js';

import type { components } from './openapi.gen.js';

// --- Enums ---
export type OrderSide = components['schemas']['OrderSide'];

// --- Core entities ---
export type User = components['schemas']['User'];
export type Identity = components['schemas']['Identity'];

// --- Response types ---
export type ApiError = components['schemas']['ApiError'];
export type MeResponse = components['schemas']['MeResponse'];
export type UniverseItem = components['schemas']['UniverseItem'];
export type UniverseResponse = components['schemas']['UniverseResponse'];
export type PriceBar = components['schemas']['PriceBar'];
export type PricesResponse = components['schemas']['PricesResponse'];
export type EvaluatedOrder = components['schemas']['EvaluatedOrder'];
export type FinalPosition = components['schemas']['FinalPosition'];
export type EquityPoint = components['schemas']['EquityPoint'];
export type EvaluateResponse = components['schemas']['EvaluateResponse'];

// --- ETF ---
export type EtfWeight = components['schemas']['EtfWeight'];
export type Etf = components['schemas']['Etf'];
export type EtfSummary = components['schemas']['EtfSummary'];
export type EtfListResponse = components['schemas']['EtfListResponse'];
export type EtfReturnsResponse = components['schemas']['EtfReturnsResponse'];

// --- Strategy / backtest ---
export type StrategyLeg = components['schemas']['StrategyLeg'];
export type StrategyBacktestResponse =
  components['schemas']['StrategyBacktestResponse'];

// --- Request types ---
export type EvaluateOrder = components['schemas']['EvaluateOrder'];
export type EvaluateRequest = components['schemas']['EvaluateRequest'];
export type CreateEtfRequest = components['schemas']['CreateEtfRequest'];
export type SmaStrategyRequest = components['schemas']['SmaStrategyRequest'];
export type UpsertUniverseRequest =
  components['schemas']['UpsertUniverseRequest'];
export type BackfillRequest = components['schemas']['BackfillRequest'];

// --- Admin / ops ---
export type OpsResponse = components['schemas']['OpsResponse'];
