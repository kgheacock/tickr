import { pool } from '../db/pool.js';

function toCents(usd: number): number {
  return Math.round(usd * 100);
}

export interface InsertableBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

// Uses unnest to pass all rows as parallel arrays — avoids the 65,535
// bind-parameter limit that chunked multi-row VALUES would hit.
export async function insertBars(
  symbol: string,
  rows: InsertableBar[],
): Promise<void> {
  if (rows.length === 0) return;
  await pool.query(
    `INSERT INTO price_bar (symbol, ts, open, high, low, close, volume)
     SELECT
       unnest($1::text[])          AS symbol,
       unnest($2::timestamptz[])   AS ts,
       unnest($3::bigint[])        AS open,
       unnest($4::bigint[])        AS high,
       unnest($5::bigint[])        AS low,
       unnest($6::bigint[])        AS close,
       unnest($7::numeric[])       AS volume
     ON CONFLICT (symbol, ts) DO NOTHING`,
    [
      rows.map(() => symbol),
      rows.map((r) => new Date(r.t).toISOString()),
      rows.map((r) => toCents(r.o)),
      rows.map((r) => toCents(r.h)),
      rows.map((r) => toCents(r.l)),
      rows.map((r) => toCents(r.c)),
      rows.map((r) => r.v ?? null),
    ],
  );
}
