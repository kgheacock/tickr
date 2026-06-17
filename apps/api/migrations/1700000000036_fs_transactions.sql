-- Fantasy Street item 07: waivers & trades — mid-season roster movement.
--
-- Rosters change between weeks through two paths, both preserving the
-- single-owner invariant (fs_roster_entry's UNIQUE (league_id, symbol)):
--   waiver claim  — add an undrafted stock, drop one (roster size fixed).
--   trade         — managers swap owned tickers; ownership is re-keyed, never
--                   duplicated, so the invariant holds for the whole txn.
-- Both resolve in the unlocked between-weeks window (after the Friday settle,
-- before the Monday lock); see TODO/fantasy-street/07-waivers-and-trades.md.
--
--   fs_waiver_claim — a queued add/drop request, resolved by the waiver run.
--   fs_trade        — a proposal between two managers + its lifecycle.
--   fs_trade_item   — the legs of a trade (which symbols move which direction).
--   fs_waiver_order — the rolling reverse-standings priority order.

-- A manager's request to add `add_symbol` and drop `drop_symbol` in one move.
-- Queued `pending`; the waiver run (fantasy/waivers.ts) awards contested adds to
-- the highest-priority claimant and marks the rest. `invalid` is set when the
-- claim can no longer apply at run time (drop already gone, add no longer free).
CREATE TABLE fs_waiver_claim (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id    UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  season       SMALLINT    NOT NULL DEFAULT 1,
  user_id      UUID        NOT NULL REFERENCES app_user(id),
  add_symbol   TEXT        NOT NULL REFERENCES universe_symbol(symbol),
  drop_symbol  TEXT        NOT NULL REFERENCES universe_symbol(symbol),
  is_short     BOOLEAN     NOT NULL DEFAULT false,
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'won', 'lost', 'invalid')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- The waiver run groups pending claims by add_symbol; this index serves both
-- that grouping and a manager's "my claims" read.
CREATE INDEX fs_waiver_claim_league_status_idx
  ON fs_waiver_claim (league_id, season, status);
CREATE INDEX fs_waiver_claim_user_idx
  ON fs_waiver_claim (league_id, user_id);

-- A proposed swap between two managers in the same league. The legs live in
-- fs_trade_item; this row carries the lifecycle. Acceptance re-keys the roster
-- rows atomically (see fantasy/trades.ts).
CREATE TABLE fs_trade (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  league_id        UUID        NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  proposer_user_id UUID        NOT NULL REFERENCES app_user(id),
  target_user_id   UUID        NOT NULL REFERENCES app_user(id),
  status           TEXT        NOT NULL DEFAULT 'proposed'
                     CHECK (status IN
                       ('proposed', 'accepted', 'rejected', 'cancelled', 'expired')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  CHECK (proposer_user_id <> target_user_id)
);

CREATE INDEX fs_trade_league_target_idx ON fs_trade (league_id, target_user_id);
CREATE INDEX fs_trade_league_proposer_idx ON fs_trade (league_id, proposer_user_id);

-- One leg of a trade: `symbol` moves *from* `from_user_id` to the other party.
-- is_short rides along so the position keeps its long/short sense after the swap.
CREATE TABLE fs_trade_item (
  trade_id     UUID    NOT NULL REFERENCES fs_trade(id) ON DELETE CASCADE,
  from_user_id UUID    NOT NULL REFERENCES app_user(id),
  symbol       TEXT    NOT NULL REFERENCES universe_symbol(symbol),
  is_short     BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (trade_id, symbol)
);

-- The rolling waiver priority order. One row per (league, season, manager);
-- lower `priority` claims first. Seeded lazily from reverse standings (worst
-- record first) when absent, then a winning claimant is demoted to the back.
CREATE TABLE fs_waiver_order (
  league_id  UUID     NOT NULL REFERENCES fs_league(id) ON DELETE CASCADE,
  season     SMALLINT NOT NULL DEFAULT 1,
  user_id    UUID     NOT NULL REFERENCES app_user(id),
  priority   SMALLINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, season, user_id)
);
