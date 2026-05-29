import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from './pool.js';

const csvPath = fileURLToPath(new URL('../../data/sp500.csv', import.meta.url));

interface SymbolRow {
  symbol: string;
  name: string;
}

function loadCsv(): SymbolRow[] {
  const text = readFileSync(csvPath, 'utf-8');
  const [, ...lines] = text.split('\n'); // skip header
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const commaIdx = line.indexOf(',');
      const symbol = line.slice(0, commaIdx).trim();
      const name = line
        .slice(commaIdx + 1)
        .replace(/^"|"$/g, '')
        .trim();
      return { symbol, name };
    });
}

export async function seedUniverse(): Promise<void> {
  const rows = loadCsv();
  const client = await pool.connect();
  try {
    let inserted = 0;
    let skipped = 0;
    for (const { symbol } of rows) {
      const result = await client.query<{ symbol: string }>(
        `INSERT INTO universe_symbol (symbol, backfilled)
         VALUES ($1, false)
         ON CONFLICT (symbol) DO NOTHING
         RETURNING symbol`,
        [symbol],
      );
      if ((result.rowCount ?? 0) > 0) {
        inserted++;
      } else {
        skipped++;
      }
    }
    console.log(
      `[seed:universe] inserted=${inserted} skipped=${skipped} total=${rows.length}`,
    );
  } finally {
    client.release();
  }
}

const thisFile = fileURLToPath(import.meta.url);
const mainFile = process.argv[1] ? resolve(process.argv[1]) : '';

if (mainFile === thisFile) {
  await seedUniverse()
    .then(() => pool.end())
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
