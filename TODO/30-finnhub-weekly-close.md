# 30 — Finnhub early weekly-close capture

> **Status:** in review • **Plan PR:** [#80](https://github.com/kgheacock/tickr/pull/80) • **Impl PR:** [#83](https://github.com/kgheacock/tickr/pull/83) • **Daily-cadence follow-on:** [#88](https://github.com/kgheacock/tickr/pull/88) • **Depends on:** 05, 13, 26 • **Consumer:** [FS-05 scoring](fantasy-street/05-scoring-and-shorting.md)

> **Follow-on (PR #88):** the capture cron was widened from **Friday-only** to
> **every trading day** (`0 30 21 * * 1-5`, NYSE-holiday-skipped) so `session_close`
> now records each session's close, not just Friday's — the one-line widening the
> Open Question below anticipated. The job was already day-agnostic (keyed on
> `mostRecentSessionDate`); `price_bar` stays the authoritative Massive-backfilled
> store, `session_close` its parallel provisional sibling. Consumer wiring (the
> FS-05 COALESCE) remains pending, unchanged by #88.

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
  Thursday's close and mis-score the week. (The `price_bar` side of this gap is
  separately narrowed by the Saturday catch-up sweep — [item 26 follow-on /
  PR #86](26-schedule-data-jobs-cron.md) — but this `session_close` stopgap is
  still needed for the *Friday-evening* settle, hours before any Saturday sweep.)
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
- **Capture cadence.** A holiday-aware post-close cron under a Redis lock at
  21:30 UTC (`c` has settled by 21:00 UTC so 21:30 is safe). Originally
  Friday-only (`0 30 21 * * 5`, sufficient for weekly scoring); **widened to
  every trading day (`0 30 21 * * 1-5`, holiday-skipped) in PR #88** so every
  session's close is recorded. See open question.

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

- **Friday-only vs every weekday.** ~~**Decided: Friday-only** (`0 30 21 * * 5`).~~
  **Reversed in PR #88 → every trading day (`0 30 21 * * 1-5`, holiday-skipped).**
  Friday-only satisfied the only live consumer (FS-05 weekly scoring) at the
  minimum Finnhub spend, and the widening was always flagged as a one-line change
  if a daily consumer appeared. The daily capture builds out the platform's
  pricing coverage — each session's close lands hours-to-days before Massive's
  ~24h-delayed bars — at ~5× the `/quote` volume (~10k calls/month; still within
  the 60 req/min bucket, but confirm against any Finnhub monthly cap).

## Definition of done

- [x] `schema/finnhub.io/openapi.json` is the trimmed OpenAPI 3.0 spec and
      `gen:finnhub` regenerates `finnhub.gen.ts` deterministically. *(spec landed
      in the doc-only change; `gen:finnhub` wiring is step 2)*
- [x] `session_close` persists `(symbol, session_date) → close` in cents; the
      Friday post-close job upserts every playable symbol idempotently.
- [x] The capture runs only in the `worker` role through the Redis token bucket
      (no un-bucketed Finnhub call; non-worker import throws).
- [x] `price_bar` and `insertBars` are **unchanged** — provisional closes never
      enter the authoritative store; `replay.ts`/`prices.ts` are untouched.
- [x] FS-05's Friday close resolution prefers authoritative `price_bar` and falls
      back to `session_close`; documented in FS-05.
- [x] `tsc --noEmit`, prettier, and eslint clean; tests above pass.
