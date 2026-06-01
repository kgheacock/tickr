# 14 — Kaggle client (bulk historical backfill)

> **Status:** [done](https://github.com/kgheacock/tickr/pull/9) • **Depends on:** 03, 13

## Goal

Use the Kaggle dataset
[US Stock Market History Data - csv](https://www.kaggle.com/datasets/ericstanley/us-stock-market-history-data-csv)
(CC0 Public Domain, ~362 MB zipped) as a **faster bootstrap source** for
`price_bar`. A single bulk download replaces hundreds of rate-limited Massive
API calls for the historical window. After the Kaggle import, the existing
Massive backfill fills the gap from the dataset's cutoff (~July 2024) to the
present.

### Dataset contents

| File | Columns | Role |
|---|---|---|
| `history.csv` | Date, Open, High, Low, Close, Adj Close, Volume, Symbol | Primary — maps 1-to-1 onto `price_bar` |
| `dividends.csv` | Date, Dividends, Symbol | v1: ignored |
| `splits.csv` | Date, Stock Splits, Symbol | v1: ignored |

`history.csv` is pre-sorted; all prices are in USD (convert to cents on
insert, same as the Massive path). `Adj Close` is split/dividend adjusted; see
[decision K3](#decisions) below.

## Pre-reads

- [TODO/13-massive-client.md](13-massive-client.md) — existing backfill client
  this supplements; the Massive gap-fill job is updated in step 7 below.
- [TODO/06-backfill-and-daily-price.md](06-backfill-and-daily-price.md) —
  `backfilled` flag semantics and scheduler integration.
- [docs/09-open-questions.md T2c](../docs/09-open-questions.md#open-market-data-questions)
  — Massive free-tier history depth (~June 2024 cutoff); defines where the
  Kaggle→Massive handoff falls.

## Decisions

| # | Question | Decision |
|---|---|---|
| K1 | Script vs job | **Bootstrap script** (`scripts/kaggle-backfill.ts`). The 362 MB archive is a one-time cost; it has no place in the recurring worker job loop. |
| K2 | Stream vs full-load | **Stream parse** `history.csv`. After decompression `history.csv` is several GB uncompressed; hold at most one symbol's worth of rows in memory at once. |
| K3 | `Adj Close` column | **Ignore in v1** — `price_bar` has no `adj_close` column; the trading engine uses `close` everywhere. Revisit in v2 if split-adjusted charts become a requirement (will need a migration). |
| K4 | Kaggle → Massive handoff | After the Kaggle import marks every matching symbol `backfilled = true`, re-run Massive backfill with `BACKFILL_LOOKBACK_DAYS` trimmed to cover only the gap (`today − kaggle_cutoff_date`). Hardcode `KAGGLE_CUTOFF_DATE=2024-07-06` (the dataset's `dateModified`). Duplicate bars in the overlap window are absorbed by `ON CONFLICT (symbol, ts) DO NOTHING`. |
| K5 | Auth | Kaggle API v1 uses HTTP Basic auth: `base64(KAGGLE_USERNAME:KAGGLE_API_KEY)`. Both env vars are required. |
| K6 | Symbol filtering | Only import rows where `Symbol` appears in `universe_symbol`. Load the set once at startup; skip unknown symbols silently (log a one-time summary at the end). |

## Steps

1. **Env vars.** Add `KAGGLE_USERNAME=` and `KAGGLE_API_KEY=` (already present)
   to `.env.example`. Validate both at script startup; print a clear error and
   exit if either is absent.

2. **Kaggle downloader.** `apps/api/src/kaggle/client.ts` exports:
   ```ts
   downloadDataset(slug: string): Promise<NodeJS.ReadableStream>
   ```
   - Slug format: `"ericstanley/us-stock-market-history-data-csv"`
   - Downloads from
     `https://www.kaggle.com/api/v1/datasets/download/{slug}`
   - `Authorization: Basic base64(KAGGLE_USERNAME:KAGGLE_API_KEY)`
   - Follows the single HTTP redirect Kaggle emits before the S3 presigned URL.
   - Streams the response; does not buffer to disk.
   - Times out at 120 s (archive is large; not a latency-sensitive path).

3. **CSV streaming parser.** `apps/api/src/kaggle/parseHistory.ts` exports:
   ```ts
   parseHistory(
     input: NodeJS.ReadableStream,
     onBatch: (symbol: string, rows: HistoryRow[]) => Promise<void>,
     knownSymbols: Set<string>,
   ): Promise<{ imported: number; skipped: number }>
   ```
   - Pipe: `input → unzip (entry: history.csv) → csv-parse (streaming)`
   - Buffer rows per symbol (they are contiguous in the file). When the
     symbol changes, call `onBatch`, then clear the buffer.
   - `HistoryRow`: `{ date: string; open: number; high: number; low: number;
     close: number; volume: number | null }` (`Adj Close` parsed but
     discarded).
   - Skip rows where `Symbol` is not in `knownSymbols`.
   - Parse errors on a row → log + skip that row (don't abort the whole
     import).

4. **Bootstrap script.** `scripts/kaggle-backfill.ts`:
   ```
   load universe_symbols → knownSymbols (Set)
   stream = kaggleClient.downloadDataset("ericstanley/us-stock-market-history-data-csv")
   parseHistory(stream, onBatch, knownSymbols)
     where onBatch(symbol, rows):
       insertBars(symbol, rows)           // reuse backfill.ts helper, or inline
       UPDATE universe_symbol SET backfilled = true, backfilled_at = now()
       WHERE symbol = $1
   log summary: N symbols imported, M symbols skipped, K rows inserted
   ```
   Run with: `npx tsx scripts/kaggle-backfill.ts`

5. **`insertBars` reuse.** Extract the existing `insertBars` function from
   `apps/api/src/jobs/backfill.ts` into a shared helper
   `apps/api/src/jobs/insertBars.ts`. Both the Massive backfill job and the
   Kaggle script import from there. The function signature stays:
   ```ts
   insertBars(symbol: string, rows: Array<{ t: number; o: number; h: number;
     l: number; c: number; v: number | null }>): Promise<void>
   ```
   `parseHistory`'s `HistoryRow` uses `date: string` (ISO `YYYY-MM-DD`);
   convert to milliseconds before calling `insertBars`:
   `new Date(row.date).getTime()`.

6. **`package.json` script.** Add:
   ```json
   "kaggle:backfill": "tsx scripts/kaggle-backfill.ts"
   ```

7. **Massive gap-fill.** After the Kaggle import completes, the Massive
   backfill only needs to cover `KAGGLE_CUTOFF_DATE → today`. Update
   `apps/api/src/jobs/backfill.ts` to respect a new env var:
   ```
   BACKFILL_START_DATE=2024-07-06   # overrides LOOKBACK_DAYS if set
   ```
   When `BACKFILL_START_DATE` is set, compute `lookbackDays` from that date
   instead of `BACKFILL_LOOKBACK_DAYS`. Document in `.env.example`:
   ```
   # Set after running scripts/kaggle-backfill.ts to fill only the gap
   # BACKFILL_START_DATE=2024-07-06
   ```

8. **`worker.ts` startup note.** No change to the worker role — the Kaggle
   script is a CLI tool, not a recurring job. Add a comment in `worker.ts`
   near the backfill registration pointing to the Kaggle pre-warm step in
   the deployment runbook.

9. **Tests.** `apps/api/test/kaggle/*.test.ts`:
   - `parseHistory` with a 3-row fixture CSV (2 symbols, 1 unknown):
     - `onBatch` called once per known symbol.
     - Row with unknown symbol is counted in `skipped`.
     - `Adj Close` column is present in fixture but not passed to `onBatch`.
   - `insertBars` (shared helper) — move existing test coverage from
     `backfill.test.ts` or add a focused test for the extracted function.
   - Download client: assert `Authorization` header is set correctly; mock
     the HTTP response with a minimal zip stream.

## Files to create / modify

| File | Action |
|---|---|
| `apps/api/src/kaggle/client.ts` | new |
| `apps/api/src/kaggle/parseHistory.ts` | new |
| `apps/api/src/jobs/insertBars.ts` | new (extracted from `backfill.ts`) |
| `apps/api/src/jobs/backfill.ts` | import `insertBars` from shared helper; add `BACKFILL_START_DATE` support |
| `scripts/kaggle-backfill.ts` | new |
| `apps/api/test/kaggle/client.test.ts` | new |
| `apps/api/test/kaggle/parseHistory.test.ts` | new |
| `.env.example` | add `KAGGLE_USERNAME=`; annotate `BACKFILL_START_DATE` |
| `package.json` | add `kaggle:backfill` script |

## Definition of done

- [ ] `ppnpm run kaggle:backfill` completes against the real Kaggle API;
      `universe_symbol.backfilled = true` for every symbol present in the
      dataset.
- [ ] `price_bar` rows for imported symbols span the dataset's full date range.
- [ ] Re-running the script is a no-op (all inserts hit `ON CONFLICT DO NOTHING`).
- [ ] After the Kaggle import, `runBackfill` with `BACKFILL_START_DATE=2024-07-06`
      makes only the gap-window Massive calls (verified by log output).
- [ ] `parseHistory` unit test passes with the 3-row fixture.
- [ ] `KAGGLE_API_KEY` never appears in logs.
- [ ] All existing tests pass (`pnpm test`).
