import type { UniverseResponse, PricesResponse, ApiError } from './index.js';

export type WsTopic =
  | { kind: 'universe' } // corpus membership / backfill state changes
  | { kind: 'prices'; symbols: string[] }; // new bars for the named symbols

export type WsClientMessage =
  | { type: 'subscribe'; topic: WsTopic }
  | { type: 'unsubscribe'; topic: WsTopic };

export type WsServerMessage =
  | { type: 'universe.updated'; data: UniverseResponse }
  | { type: 'prices.updated'; asOf: string; series: PricesResponse['series'] }
  | { type: 'error'; error: ApiError['error'] };
