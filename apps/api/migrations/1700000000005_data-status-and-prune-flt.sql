-- Data remediation (docs/12-data-remediation-plan.md).
--
-- 1. data_status — terminal coverage mark set by the backfill:
--      NULL        not yet attempted (or pre-existing rows before this column)
--      'ok'        full coverage to ~now
--      'incomplete' source has no recent data (depth-capped / partially delisted);
--                  excluded from the playable corpus and skipped by the re-arm step
--    Fully-empty symbols are never marked here — they stay backfilled = false and
--    are hard-removed by the bootstrap prune (run-backfill.ts).
--
-- 2. FLT — FleetCor rebranded to CPAY in 2024 (already in the universe). The
--    Massive API has no data for FLT in the audit window, so it is a permanently
--    dead ticker. Remove it (and any FK children) so it is not a stale NO_BARS
--    row. FLT is also dropped from data/sp500.csv so the seed never re-adds it.

ALTER TABLE universe_symbol ADD COLUMN IF NOT EXISTS data_status TEXT;

-- FK children of universe_symbol(symbol) must go first. After migration 003
-- (platformize) only price_bar and etf_weight still reference it — the game
-- tables (position/trade_order/…) were dropped.
DELETE FROM price_bar  WHERE symbol = 'FLT';
DELETE FROM etf_weight WHERE symbol = 'FLT';
DELETE FROM universe_symbol WHERE symbol = 'FLT';
