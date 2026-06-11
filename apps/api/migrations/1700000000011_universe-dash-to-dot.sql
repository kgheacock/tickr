-- Normalize multi-class tickers from the dashed form to the dotted form.
--
-- The universe is now sourced from Wikipedia, which (like Massive/Polygon) writes
-- share classes with a dot: BRK.B, MOG.A. Previously we seeded from a CSV that
-- used a dash (BRK-B, MOG-A) and converted dash→dot only at the Massive call
-- site (toMassiveTicker). Storing the dotted form directly makes the stored key
-- match the source and the API, and keeps toMassiveTicker a harmless no-op.
--
-- Without this rename the dotted seed would INSERT *new* rows alongside the old
-- dashed ones, orphaning the existing price_bar history under the dashed key and
-- creating duplicate universe members. Renaming preserves the row and its
-- history (we never drop a ticker) and repoints every FK child.
--
-- universe_symbol(symbol) is a PK referenced by price_bar, etf_weight,
-- symbol_metadata, symbol_branding (no ON UPDATE CASCADE), so we cannot UPDATE
-- the parent key in place. Instead: copy the parent row under the new key,
-- repoint all children, then delete the old parent. Each step is guarded on the
-- dashed symbol still existing, so this is a no-op on a fresh DB (already dotted)
-- and safe to apply once on an existing one.

-- ── BRK-B → BRK.B ────────────────────────────────────────────────────────────
INSERT INTO universe_symbol (symbol, added_at, removed_at, backfilled, backfilled_at, data_status)
SELECT 'BRK.B', added_at, removed_at, backfilled, backfilled_at, data_status
  FROM universe_symbol WHERE symbol = 'BRK-B'
ON CONFLICT (symbol) DO NOTHING;

UPDATE price_bar       SET symbol = 'BRK.B' WHERE symbol = 'BRK-B';
UPDATE etf_weight      SET symbol = 'BRK.B' WHERE symbol = 'BRK-B';
UPDATE symbol_metadata SET symbol = 'BRK.B' WHERE symbol = 'BRK-B';
UPDATE symbol_branding SET symbol = 'BRK.B' WHERE symbol = 'BRK-B';

DELETE FROM universe_symbol WHERE symbol = 'BRK-B';

-- ── MOG-A → MOG.A ────────────────────────────────────────────────────────────
INSERT INTO universe_symbol (symbol, added_at, removed_at, backfilled, backfilled_at, data_status)
SELECT 'MOG.A', added_at, removed_at, backfilled, backfilled_at, data_status
  FROM universe_symbol WHERE symbol = 'MOG-A'
ON CONFLICT (symbol) DO NOTHING;

UPDATE price_bar       SET symbol = 'MOG.A' WHERE symbol = 'MOG-A';
UPDATE etf_weight      SET symbol = 'MOG.A' WHERE symbol = 'MOG-A';
UPDATE symbol_metadata SET symbol = 'MOG.A' WHERE symbol = 'MOG-A';
UPDATE symbol_branding SET symbol = 'MOG.A' WHERE symbol = 'MOG-A';

DELETE FROM universe_symbol WHERE symbol = 'MOG-A';
