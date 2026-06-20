-- Provisional same-day session closes from Finnhub /quote (TODO/30).
--
-- WHY THIS EXISTS, SEPARATE FROM price_bar:
--   Massive's free tier returns 403 NOT_AUTHORIZED for the *current* trading day;
--   a session's 15-min bars only land the next trading day, and the intraday
--   sweep is gated to regular sessions so it never runs on weekends. Friday's
--   close therefore doesn't reach price_bar until Monday. The Fantasy Street
--   weekly scorer (FS-05) settles Friday evening and would otherwise walk back to
--   Thursday and mis-score the week. Finnhub /quote `c` freezes at the official
--   regular-session close after 16:00 ET (verified — does not drift with
--   after-hours), so a post-close sweep can supply the close early.
--
-- WHY NOT WRITE INTO price_bar:
--   price_bar is the authoritative, Massive-pure, first-writer-wins store that
--   backtests (eval/replay.ts) and charts (routes/prices.ts) read. Provisional
--   same-day data must never reach those readers (backtest reproducibility), so
--   this lives in its own table that touches zero existing readers.
--
-- RESOLUTION (for FS-05 to implement): Friday close =
--   COALESCE(authoritative price_bar close at-or-before Friday, provisional
--   session_close for that session_date). Authoritative is keyed by `ts`,
--   provisional by `session_date`; they never collide, so when Massive's real
--   bar lands Monday the authoritative value simply wins — no overwrite or
--   precedence machinery, no phantom rows.
--
-- SUPERSEDED (FS-05, see apps/api/src/fantasy/closes.ts): FS now *prefers*
-- session_close and uses price_bar only to fill the gaps. The COALESCE order
-- above is reversed because price_bar's at-or-before lookup is non-null on a
-- Friday evening (it resolves to Thursday's bar), so a price_bar-first COALESCE
-- short-circuits and never reaches session_close — exactly the leading-edge
-- close this table exists to supply. The reversal is scoped to FS readers;
-- price_bar stays Massive-pure for backtests and charts.

CREATE TABLE session_close (
  -- tickr's stored symbol, passed to Finnhub as-is (it accepts dotted and dashed
  -- class shares identically). FK keeps the table inside the universe; rows are
  -- never hard-deleted in practice (removed_at is the retirement flag), so the
  -- cascade is only a safety net mirroring symbol_coverage_watermark.
  symbol       TEXT        NOT NULL
                 REFERENCES universe_symbol(symbol) ON DELETE CASCADE,
  -- The just-closed ET regular session this close belongs to (derived via the
  -- holiday-aware walk-back, so a holiday Friday keys to the prior trading day).
  session_date DATE        NOT NULL,
  -- Official regular-session close, in cents (round(c * 100)), matching price_bar.
  close        BIGINT      NOT NULL,
  -- Provenance; only 'finnhub' today, but explicit so a future second source is
  -- distinguishable without a schema change.
  source       TEXT        NOT NULL DEFAULT 'finnhub',
  -- When this provisional row was last written (refreshed on re-capture).
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, session_date)
);
