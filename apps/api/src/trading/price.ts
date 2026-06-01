import type pg from 'pg';
import { pool } from '../db/pool.js';

export interface LatestPrice {
  price: number;
  ts: Date;
}

const PRICE_SQL = `
  SELECT close, ts
  FROM price_bar
  WHERE symbol = $1
  ORDER BY ts DESC
  LIMIT 1
`;

export async function latestPriceClient(
  client: pg.PoolClient,
  symbol: string,
): Promise<LatestPrice | null> {
  const { rows } = await client.query<{ close: number; ts: Date }>(PRICE_SQL, [
    symbol,
  ]);
  if (!rows[0]) return null;
  return { price: rows[0].close, ts: rows[0].ts };
}

export async function latestPrice(symbol: string): Promise<LatestPrice | null> {
  const { rows } = await pool.query<{ close: number; ts: Date }>(PRICE_SQL, [
    symbol,
  ]);
  if (!rows[0]) return null;
  return { price: rows[0].close, ts: rows[0].ts };
}

export function isPriceStale(ts: Date, nowMs = Date.now()): boolean {
  const ageDays = (nowMs - ts.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > 5;
}
