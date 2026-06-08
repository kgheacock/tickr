export type { paths, components, operations } from './openapi.gen.js';
export type { WsTopic, WsClientMessage, WsServerMessage } from './ws.js';

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

// --- Request types ---
export type EvaluateOrder = components['schemas']['EvaluateOrder'];
export type EvaluateRequest = components['schemas']['EvaluateRequest'];
export type UpsertUniverseRequest =
  components['schemas']['UpsertUniverseRequest'];
export type BackfillRequest = components['schemas']['BackfillRequest'];
