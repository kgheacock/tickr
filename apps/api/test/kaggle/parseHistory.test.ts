import { describe, it, expect } from 'vitest';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { parseHistory } from '../../src/kaggle/parseHistory.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('parseHistory', () => {
  it('calls onBatch once per known symbol', async () => {
    const knownSymbols = new Set(['AAPL', 'MSFT']);
    const batches: Array<{ symbol: string; rowCount: number }> = [];

    const stream = createReadStream(join(fixtureDir, 'history.zip'));
    await parseHistory(
      stream,
      async (symbol, rows) => {
        batches.push({ symbol, rowCount: rows.length });
      },
      knownSymbols,
    );

    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.symbol).sort()).toEqual(['AAPL', 'MSFT']);
    expect(batches.every((b) => b.rowCount === 1)).toBe(true);
  });

  it('counts rows with unknown symbol in skipped', async () => {
    const knownSymbols = new Set(['AAPL']);

    const stream = createReadStream(join(fixtureDir, 'history.zip'));
    const { imported, skipped } = await parseHistory(
      stream,
      async () => {},
      knownSymbols,
    );

    expect(imported).toBe(1);
    expect(skipped).toBe(2); // MSFT and UNKNOWN rows
  });

  it('does not pass Adj Close to onBatch', async () => {
    const knownSymbols = new Set(['AAPL']);
    let capturedRows: unknown[] = [];

    const stream = createReadStream(join(fixtureDir, 'history.zip'));
    await parseHistory(
      stream,
      async (_symbol, rows) => {
        capturedRows = rows;
      },
      knownSymbols,
    );

    expect(capturedRows).toHaveLength(1);
    const row = capturedRows[0] as Record<string, unknown>;
    expect('adjClose' in row).toBe(false);
    expect('Adj Close' in row).toBe(false);
    expect(row['open']).toBeCloseTo(150.0);
    expect(row['close']).toBeCloseTo(151.0);
  });

  it('returns zero counts when knownSymbols is empty', async () => {
    const stream = createReadStream(join(fixtureDir, 'history.zip'));
    const { imported, skipped } = await parseHistory(
      stream,
      async () => {},
      new Set(),
    );

    expect(imported).toBe(0);
    expect(skipped).toBe(3);
  });
});
