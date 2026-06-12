-- Coverage high-water-mark — durable data-loss / regression guard (TODO/28 step 2).
--
-- The data audit's coverage-gap check answers "is there a hole right now," and
-- its transition-downgrade (TODO/28 step 1) answers "is a hole explained by a
-- ticker rename." Neither answers the question that matters most for silent data
-- loss: **did THIS symbol lose coverage it once had?** This table does.
--
-- Per (symbol, granularity) we persist the best coverage *ratio* ever observed
-- (covered / expected trading days within the audit window). The audit compares
-- the current ratio against this mark and reports a regression beyond tolerance
-- as an error. Keyed on coverage *ratio*, not an absolute day count, so the
-- rolling audit window's run-to-run trading-day jitter (holiday-cluster edges)
-- never moves a fully-covered symbol off 1.0 — only a genuine loss does.
--
-- Why this is complementary, not redundant, with COVERAGE_GAP:
--   * COVERAGE_GAP only fires on >= AUDIT_GAP_THRESHOLD *consecutive* missing
--     days; a diffuse loss scattered across the window slips under it but drops
--     the ratio — caught here.
--   * It is silent on a true rename (BNY never had the pre-transition bars, so
--     its ratio doesn't regress), so it does not re-introduce the false abort
--     step 1 fixed.
--
-- The mark only ever moves up (see the ON CONFLICT ... WHERE GREATEST guard in
-- run-audit.ts): a regression run never lowers it, so a transient dip can't
-- silently rebase the baseline. A genuine, *permanent* reduction therefore
-- blocks every deploy until an operator accepts the new baseline by hand:
--   DELETE FROM symbol_coverage_watermark WHERE symbol = '<TICKER>';
--
-- Scope: written only for the "playable" corpus (backfilled, not
-- data_status='incomplete') — the same set the coverage check guards. Excluded
-- (delisted/depth-capped) symbols are intentionally never watermarked, so the
-- mechanism that silences them is not undone here.

CREATE TABLE symbol_coverage_watermark (
  symbol         TEXT        NOT NULL
                   REFERENCES universe_symbol(symbol) ON DELETE CASCADE,
  -- Bar granularity the mark was measured at, e.g. '15 minute'. A config change
  -- (different granularity) starts a fresh, independent mark.
  granularity    TEXT        NOT NULL,
  -- High-water-mark: best covered/expected trading-day ratio ever observed.
  coverage_ratio DOUBLE PRECISION NOT NULL,
  -- Snapshot taken when the mark was last raised (diagnostic context):
  trading_days   INTEGER     NOT NULL,  -- covered trading days then
  expected_days  INTEGER     NOT NULL,  -- expected trading days in the window then
  oldest_ts      TIMESTAMPTZ,           -- earliest bar in the window then
  newest_ts      TIMESTAMPTZ,           -- latest bar in the window then
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the mark was last raised
  PRIMARY KEY (symbol, granularity)
);
