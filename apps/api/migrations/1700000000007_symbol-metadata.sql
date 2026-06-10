-- Ticker metadata + branding, sourced from the Massive reference API
-- (GET /v3/reference/tickers/{ticker} and the company-branding image URLs).
-- Populated by the idempotent refresh job (apps/api/src/jobs/refresh-metadata.ts,
-- `pnpm metadata`). See docs/10-populating-the-database.md.
--
-- Two tables on purpose:
--   * symbol_metadata  — lean, frequently-read company fields. No blobs, so a
--                        listing query never drags image bytes off disk.
--   * symbol_branding  — the downloaded logo/icon image bytes. Isolated so a
--                        later move to object storage is localized here and does
--                        not touch the queried metadata table.
--
-- Every fetched artifact records its own fetch timestamp so stale rows can be
-- aged out and re-fetched independently (the refresh job's selection is driven
-- off these): metadata, logo, and icon each age out on their own cadence and a
-- partial failure (logo downloaded, icon 5xx) re-arms only the missing piece.

CREATE TABLE symbol_metadata (
  symbol            TEXT PRIMARY KEY
                      REFERENCES universe_symbol(symbol) ON DELETE CASCADE,
  -- The ticker form actually requested at Massive (share-class dash → dot,
  -- e.g. BRK-B → BRK.B); kept for traceability of which form resolved.
  massive_ticker    TEXT        NOT NULL,
  name              TEXT,
  primary_exchange  TEXT,        -- MIC, e.g. XNAS / XNYS
  type              TEXT,        -- CS, ETF, …
  market_cap        NUMERIC,     -- whole currency units (not cents); can be huge
  sic_code          TEXT,
  sic_description   TEXT,        -- closest thing Massive gives to a sector
  homepage_url      TEXT,
  list_date         DATE,
  total_employees   INTEGER,
  description       TEXT,
  -- Full reference payload, so a field we did not break out is still available
  -- without a re-fetch.
  raw               JSONB,
  -- Last successful metadata fetch; NULL = never fetched. Drives age-out.
  fetched_at        TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE symbol_branding (
  symbol            TEXT PRIMARY KEY
                      REFERENCES universe_symbol(symbol) ON DELETE CASCADE,
  -- Logo (typically SVG). bytes + content_type are written together.
  logo_bytes        BYTEA,
  logo_content_type TEXT,
  logo_source_url   TEXT,        -- the Massive URL it was downloaded from
  logo_fetched_at   TIMESTAMPTZ,
  -- Icon (PNG/JPEG — the extension varies, so content_type is authoritative).
  icon_bytes        BYTEA,
  icon_content_type TEXT,
  icon_source_url   TEXT,
  icon_fetched_at   TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Age-out lookups: "which symbols have metadata/branding older than cutoff".
CREATE INDEX ON symbol_metadata (fetched_at);
CREATE INDEX ON symbol_branding (logo_fetched_at);
CREATE INDEX ON symbol_branding (icon_fetched_at);
