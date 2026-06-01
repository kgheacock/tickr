import { parse } from 'csv-parse';
import unzipper from 'unzipper';

export interface HistoryRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

function log(level: 'info' | 'warn', msg: string, extra?: object): void {
  console[level](JSON.stringify({ level, component: 'kaggle', msg, ...extra }));
}

export async function parseHistory(
  input: NodeJS.ReadableStream,
  onBatch: (symbol: string, rows: HistoryRow[]) => Promise<void>,
  knownSymbols: Set<string>,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  const zip = input.pipe(unzipper.Parse({ forceStream: true }));

  for await (const rawEntry of zip) {
    const entry = rawEntry as unzipper.Entry;
    if (entry.path !== 'history.csv') {
      entry.autodrain();
      continue;
    }

    const parser = entry.pipe(parse({ columns: true, relax_quotes: true }));

    let currentSymbol: string | null = null;
    let buffer: HistoryRow[] = [];

    for await (const rawRecord of parser) {
      const record = rawRecord as Record<string, string>;
      const symbol = record['Symbol'] ?? '';

      if (!knownSymbols.has(symbol)) {
        skipped++;
        continue;
      }

      if (symbol !== currentSymbol) {
        if (currentSymbol !== null && buffer.length > 0) {
          await onBatch(currentSymbol, buffer);
          imported += buffer.length;
        }
        currentSymbol = symbol;
        buffer = [];
      }

      let row: HistoryRow;
      try {
        const open = parseFloat(record['Open'] ?? '');
        const high = parseFloat(record['High'] ?? '');
        const low = parseFloat(record['Low'] ?? '');
        const close = parseFloat(record['Close'] ?? '');
        const volStr = record['Volume'];
        const volume =
          volStr && volStr.trim() !== '' ? parseFloat(volStr) : null;

        if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) {
          throw new Error('NaN in price fields');
        }
        row = { date: record['Date'] ?? '', open, high, low, close, volume };
      } catch (err) {
        log('warn', 'row parse error', {
          symbol,
          err: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      buffer.push(row);
    }

    if (currentSymbol !== null && buffer.length > 0) {
      await onBatch(currentSymbol, buffer);
      imported += buffer.length;
    }
  }

  return { imported, skipped };
}
