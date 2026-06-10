-- Fantasy Street item 02: player (stock) classification + the ownership table.
--
-- Two tables live here despite the "classification" name:
--   1. fs_player_classification — price-derived group eligibility per symbol.
--   2. fs_roster_entry — the per-league single-owner ownership table. Its
--      canonical shape is specified by FS-03 (live draft), but FS-02 must read
--      it to surface ownership in the player inventory, and FS-02 ships first —
--      so the table is created here. FS-03 *extends* it (draft writes), it does
--      not re-create it. See TODO/fantasy-street/03-live-draft.md.

-- Price-derived group eligibility. One row per (symbol, group) the symbol
-- qualifies for; absence of a row means "not eligible for that group". The
-- classifier (fantasy/classify.ts) recomputes this from price_bar; it is
-- idempotent (a re-run yields the same group/eligible/metrics rows).
--
-- Groups are computed purely from price history (trailing returns + volatility).
-- Sector / market-cap tier — which would sharpen Anchor and Value — is an OPEN
-- DATA ITEM pending a fundamentals feed; until then Value is a price-only proxy.
CREATE TABLE fs_player_classification (
  symbol      TEXT        NOT NULL REFERENCES universe_symbol(symbol),
  "group"     TEXT        NOT NULL CHECK ("group" IN
                ('anchor', 'growth', 'momentum', 'value', 'defense', 'wildcard')),
  eligible    BOOLEAN     NOT NULL DEFAULT true,
  metrics     JSONB       NOT NULL,  -- trailing returns + σ used for the decision
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, "group")
);

CREATE INDEX fs_player_classification_group_idx
  ON fs_player_classification ("group") WHERE eligible;

-- Per-league exclusive ownership. The single-owner invariant — a ticker belongs
-- to exactly one manager (long OR short) within a league — is the UNIQUE below.
-- FS-03's draft is the write path; FS-02 only reads this to surface ownership.
CREATE TABLE fs_roster_entry (
  league_id    UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES app_user(id),
  symbol       TEXT        NOT NULL REFERENCES universe_symbol(symbol),
  is_short     BOOLEAN     NOT NULL DEFAULT false,
  acquired_via TEXT        NOT NULL CHECK (acquired_via IN ('draft', 'waiver', 'trade')),
  acquired_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, user_id, symbol),
  -- Single-owner invariant: one manager per ticker per league, long or short.
  UNIQUE (league_id, symbol)
);

CREATE INDEX fs_roster_entry_league_idx ON fs_roster_entry (league_id);
