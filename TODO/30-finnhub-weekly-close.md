# 30 — Finnhub early weekly-close capture

> **Status:** pending • **Depends on:** 05, 13, 26 • **Consumer:** [FS-05 scoring](fantasy-street/05-scoring-and-shorting.md)

## Goal

Capture each trading session's **official closing price** from Finnhub `/quote`
right after the 16:00-ET close and persist it to a **provisional `session_close`
store**, so the Fantasy Street **Friday scorer** (FS-05, fires `0 30 21 * * 5`
= 21:30 UTC) can **settle the week Friday evening** instead of waiting for the
Massive free-tier bars that don't arrive until the next trading day.

Massive's 15-min `price_bar` stays the **authoritative** record of "what
happened that day"; the Finnhub close is a stopgap the scorer prefers **only
when the authoritative close isn't present yet**.

## Background / why this exists

- **The gap.** Massive's free tier returns `403 NOT_AUTHORIZED` for the current
  trading day; a session's 15-min bars only appear the *next* trading day. The
  intraday sweep is gated to regular sessions (`scheduler.ts` `isRegularSession`),
  so it never runs on weekends — **Friday's close doesn't reach `price_bar` until
  Monday.** The FS-05 Friday scorer at 21:30 UTC would otherwise walk back to
  Thursday's close and mis-score the week.
- **Finnhub fills the close, not the intraday.** Free `/quote` returns today's
  data including `c` (current price). Verified post-close: `c` **freezes at the
  official regular-session close and does not drift with after-hours** (TMO 469.34
  stable across repeated polls 48 min apart). `/stock/candle` is `403` on free —
  no intraday history — so Finnhub can supply the **daily close only**.
- **Symbol mapping is a no-op.** Finnhub accepts tickr's stored symbols as-is
  (verified `MOG-A`, `BRK-B` resolve identically to dotted forms).

## Design decisions

- **Separate provisional store — do NOT write into `price_bar`.** `price_bar`
  stays Massive-pure and immutable (first-writer-wins; `insertBars` is
  `ON CONFLICT DO NOTHING`). The **only** consumer needing the close before
  Monday is the *pending* FS-05 scorer; backtests (`eval/replay.ts`) and charts
  (`prices.ts`) read `price_bar.close` and **must not** see provisional same-day
  data (backtest reproducibility). A new `session_close` table therefore touches
  **zero existing readers**.
- **Resolution order (for FS-05 to implement).** Friday close =
  `COALESCE(authoritative price_bar close at-or-before Friday, provisional
  session_close for that session_date)`. When Massive's real bar lands Monday,
  the authoritative value wins automatically — **no overwrite/precedence
  machinery, no phantom rows** (provisional is keyed by `session_date`,
  authoritative by `ts`; they never collide).
- **Reuse the prescribed Finnhub client.** It existed (TODO/05, PR #8) and was
  deleted in `b50632d` when Massive replaced Finnhub. Resurrect
  `apps/api/src/finnhub/{client,bucket,index}.ts` + regenerated types from
  `schema/finnhub.io/openapi.json`. Worker-role-only (import-time role guard);
  Redis token bucket honors the 60 req/min free tier — a ~502-symbol sweep takes
  ~9 min, comfortably inside the post-close window.
- **Capture cadence.** A holiday-aware post-close cron under a Redis lock,
  aligned with FS-05's `0 30 21 * * 5` (Friday only is sufficient for weekly
  scoring; `c` has settled by 21:00 UTC so 21:30 is safe). See open question.

## Steps (to build — not in this doc-only change)

1. **Schema** `17000000000XX_session-close.sql` — `session_close`:
   `symbol TEXT`, `session_date DATE`, `close BIGINT` (cents),
   `source TEXT NOT NULL DEFAULT 'finnhub'`, `captured_at timestamptz NOT NULL
   DEFAULT now()`, `PRIMARY KEY (symbol, session_date)`.
2. **Resurrect the Finnhub client** from `fbe0cbd` (`client.ts`, `bucket.ts`,
   `index.ts`); regenerate `apps/api/src/finnhub/finnhub.gen.ts` from
   `schema/finnhub.io/openapi.json`; re-add the `gen:finnhub` package script
   (mirror `gen:massive`).
3. **Capture job** `apps/api/src/jobs/close-capture.ts` — load the playable
   corpus (same predicate as `runIntradayUpdate`), `finnhubGet('/quote', {symbol})`
   per symbol through the bucket, upsert `session_close` with
   `close = round(c * 100)` and `session_date` = the just-closed session.
4. **Schedule** the Friday post-close firing in `jobs/scheduler.ts`
   (`0 30 21 * * 5`, holiday-aware, Redis lock) → `runCloseCapture`.
5. **Hand-off note** in `fantasy-street/05-scoring-and-shorting.md`: `weeklyReturn`
   resolves the authoritative `price_bar` close else the provisional
   `session_close`.
6. **Tests** — bucket honors 60/min; capture upserts cents correctly and is
   idempotent; non-worker import throws; close resolution prefers authoritative
   over provisional.

## Files

- Create: `apps/api/migrations/17000000000XX_session-close.sql`,
  `apps/api/src/finnhub/{client,bucket,index,finnhub.gen}.ts`,
  `apps/api/src/jobs/close-capture.ts`,
  `apps/api/test/finnhub/*.test.ts`, `apps/api/test/jobs/close-capture.test.ts`.
- Edit: `apps/api/src/jobs/scheduler.ts` (Friday close-capture cron),
  `package.json` (`gen:finnhub`),
  `TODO/fantasy-street/05-scoring-and-shorting.md` (resolution note).
- **Done in the doc-only change:** `schema/finnhub.io/openapi.json` (Swagger 2.0
  → OpenAPI 3.0, trimmed to `/quote`), this file, the `TODO/README.md` index row.

## Open questions

- **Friday-only vs every weekday.** Friday-only satisfies weekly scoring.
  Capturing every weekday close would also keep the admin worst-lag chip
  (item 29) from reading ~1 day stale off-hours, at ~9 min of Finnhub budget per
  day. Decide before step 4; record in `docs/09-open-questions.md` if contested.

## Definition of done

- [ ] `schema/finnhub.io/openapi.json` is the trimmed OpenAPI 3.0 spec and
      `gen:finnhub` regenerates `finnhub.gen.ts` deterministically. *(spec landed
      in the doc-only change; `gen:finnhub` wiring is step 2)*
- [ ] `session_close` persists `(symbol, session_date) → close` in cents; the
      Friday post-close job upserts every playable symbol idempotently.
- [ ] The capture runs only in the `worker` role through the Redis token bucket
      (no un-bucketed Finnhub call; non-worker import throws).
- [ ] `price_bar` and `insertBars` are **unchanged** — provisional closes never
      enter the authoritative store; `replay.ts`/`prices.ts` are untouched.
- [ ] FS-05's Friday close resolution prefers authoritative `price_bar` and falls
      back to `session_close`; documented in FS-05.
- [ ] `tsc --noEmit`, prettier, and eslint clean; tests above pass.
