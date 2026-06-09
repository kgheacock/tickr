/**
 * ETF CRUD business logic. Thin functions that throw EtfError for validation
 * failures, keeping the Fastify route handlers as pure glue. Mirrors the
 * loadPrices / replay pattern from prices.ts / eval/replay.ts.
 */

import type { Pool, PoolClient } from 'pg';
import type { Etf, EtfSummary, EtfReturnsResponse } from '@tickr/shared-types';
import { etfSeries } from './series.js';

export class EtfError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EtfError';
  }
}

export interface CreateEtfInput {
  key: string;
  name: string;
  baseDate?: string | undefined;
  baseValue?: number | undefined;
  weights: Record<string, number>;
}

export async function createEtf(
  input: CreateEtfInput,
  pool: Pool,
): Promise<Etf> {
  const { key, name, baseValue = 10000, weights } = input;

  const weightEntries = Object.entries(weights);
  if (weightEntries.length === 0) {
    throw new EtfError('VALIDATION', 'weights must not be empty');
  }
  const symbols = weightEntries.map(([s]) => s.toUpperCase());

  // Validate all members are in universe_symbol and are backfilled.
  const { rows: universeRows } = await pool.query<{
    symbol: string;
    backfilled: boolean;
  }>(`SELECT symbol, backfilled FROM universe_symbol WHERE symbol = ANY($1)`, [
    symbols,
  ]);
  const inUniverse = new Map(universeRows.map((r) => [r.symbol, r.backfilled]));

  const unknownMembers = symbols.filter((s) => !inUniverse.has(s));
  if (unknownMembers.length > 0) {
    throw new EtfError(
      'UNKNOWN_MEMBERS',
      `Symbols not in universe: ${unknownMembers.join(', ')}`,
    );
  }
  const notBackfilled = symbols.filter((s) => !inUniverse.get(s));
  if (notBackfilled.length > 0) {
    throw new EtfError(
      'NOT_BACKFILLED',
      `Symbols not yet backfilled: ${notBackfilled.join(', ')}`,
    );
  }

  // Default base_date to the documented "earliest common bar date": the latest
  // first-bar across members, i.e. the earliest date on which *every* member
  // already has a price. This is also what the synthetic series needs — before
  // that date a not-yet-listed member's weight would be counted with no bar,
  // producing a distorted pre-base ramp. (A barless member is still caught by
  // the UNDEFINED_BASE check below.)
  let resolvedBaseDate = input.baseDate;
  if (!resolvedBaseDate) {
    const { rows } = await pool.query<{ base_date: string | null }>(
      `SELECT MAX(first_bar)::text AS base_date
         FROM (
           SELECT symbol, MIN(ts)::date AS first_bar
             FROM price_bar
            WHERE symbol = ANY($1)
            GROUP BY symbol
         ) s`,
      [symbols],
    );
    resolvedBaseDate =
      rows[0]?.base_date ?? new Date().toISOString().slice(0, 10);
  }

  // Validate every member has a bar at or before base_date.
  const { rows: baseBarRows } = await pool.query<{ symbol: string }>(
    `SELECT DISTINCT ON (symbol) symbol
       FROM price_bar
      WHERE symbol = ANY($1)
        AND ts <= $2::date + interval '1 day'
      ORDER BY symbol, ts DESC`,
    [symbols, resolvedBaseDate],
  );
  const hasBaseBar = new Set(baseBarRows.map((r) => r.symbol));
  const missingBase = symbols.filter((s) => !hasBaseBar.has(s));
  if (missingBase.length > 0) {
    throw new EtfError(
      'UNDEFINED_BASE',
      `Members have no bar at or before baseDate ${resolvedBaseDate}: ${missingBase.join(', ')}`,
    );
  }

  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: etfRows } = await client.query<{
      id: string;
      created_at: Date;
    }>(
      `INSERT INTO etf (key, name, base_value, base_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [key, name, baseValue, resolvedBaseDate],
    );
    const etfRow = etfRows[0]!;

    for (const [rawSym, rawW] of weightEntries) {
      await client.query(
        `INSERT INTO etf_weight (etf_id, symbol, weight) VALUES ($1, $2, $3)`,
        [etfRow.id, rawSym.toUpperCase(), rawW],
      );
    }

    await client.query('COMMIT');

    const rawTotal = weightEntries.reduce((s, [, w]) => s + w, 0);
    return {
      id: etfRow.id,
      key,
      name,
      baseValue,
      baseDate: resolvedBaseDate,
      createdAt: etfRow.created_at.toISOString(),
      weights: weightEntries.map(([rawSym, rawW]) => ({
        symbol: rawSym.toUpperCase(),
        weight: rawW / rawTotal,
      })),
    };
  } catch (err: unknown) {
    await client.query('ROLLBACK');
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: string }).code === '23505'
    ) {
      throw new EtfError('DUPLICATE_KEY', `ETF key already exists: ${key}`);
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function listEtfs(pool: Pool): Promise<EtfSummary[]> {
  const { rows } = await pool.query<{
    id: string;
    key: string;
    name: string;
    member_count: string;
    created_at: Date;
  }>(
    `SELECT e.id, e.key, e.name,
            COUNT(w.symbol)::text AS member_count,
            e.created_at
       FROM etf e
       LEFT JOIN etf_weight w ON w.etf_id = e.id
       GROUP BY e.id
       ORDER BY e.created_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    memberCount: Number(r.member_count),
    createdAt: r.created_at.toISOString(),
  }));
}

export async function loadEtf(key: string, pool: Pool): Promise<Etf | null> {
  const { rows } = await pool.query<{
    id: string;
    key: string;
    name: string;
    base_value: number;
    base_date: string;
    created_at: Date;
    symbol: string;
    weight: string;
  }>(
    `SELECT e.id, e.key, e.name, e.base_value, e.base_date::text AS base_date,
            e.created_at, w.symbol, w.weight::text AS weight
       FROM etf e
       JOIN etf_weight w ON w.etf_id = e.id
      WHERE e.key = $1`,
    [key],
  );
  if (rows.length === 0) return null;

  const first = rows[0]!;
  const rawTotal = rows.reduce((s, r) => s + parseFloat(r.weight), 0);
  return {
    id: first.id,
    key: first.key,
    name: first.name,
    baseValue: first.base_value,
    baseDate: first.base_date,
    createdAt: first.created_at.toISOString(),
    weights: rows.map((r) => ({
      symbol: r.symbol,
      weight: parseFloat(r.weight) / rawTotal,
    })),
  };
}

export async function getEtfReturns(
  key: string,
  from: string,
  to: string,
  pool: Pool,
): Promise<EtfReturnsResponse> {
  const toMs = Date.parse(to);
  if (Number.isNaN(toMs)) throw new EtfError('VALIDATION', 'invalid `to`');
  const fromMs = Date.parse(from);
  if (Number.isNaN(fromMs)) throw new EtfError('VALIDATION', 'invalid `from`');

  const bars = await etfSeries(pool, key, { from, to });

  if (bars.length < 2) {
    return { from, to, returnPct: null };
  }
  const first = bars[0]!.close;
  const last = bars[bars.length - 1]!.close;
  const returnPct = first === 0 ? null : ((last - first) / first) * 100;
  return { from, to, returnPct };
}
