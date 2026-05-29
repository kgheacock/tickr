-- Core v1 schema. Tables are ordered dependency-first so each FK target
-- exists before its referencing table is created.

CREATE TABLE app_user (
  id           UUID PRIMARY KEY,
  display_name TEXT NOT NULL,
  email        TEXT,
  role         TEXT NOT NULL DEFAULT 'player'
                 CHECK (role IN ('player','admin')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- universe_symbol before algo/portfolio/position/trade_order because
-- position and trade_order both reference it.
CREATE TABLE universe_symbol (
  symbol        TEXT        PRIMARY KEY,
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  backfilled    BOOLEAN     NOT NULL DEFAULT false,
  backfilled_at TIMESTAMPTZ
);
CREATE INDEX ON universe_symbol (backfilled) WHERE backfilled = false;

CREATE TABLE algo (
  id            UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  kind          TEXT NOT NULL CHECK (kind IN ('house','user')),
  name          TEXT NOT NULL,
  strategy_type TEXT NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE portfolio (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES app_user(id),
  algo_id    UUID REFERENCES algo(id),
  cash       BIGINT NOT NULL,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one human portfolio per user (algo_id IS NULL).
-- A plain UNIQUE (user_id, algo_id) won't enforce this because NULL ≠ NULL
-- for unique constraints in Postgres — two (U, NULL) rows would both be
-- allowed. Use a partial unique index instead.
CREATE UNIQUE INDEX portfolio_one_human_per_user
  ON portfolio (user_id) WHERE algo_id IS NULL;

-- One portfolio per (user, algo) for users running algos.
CREATE UNIQUE INDEX portfolio_one_per_user_algo
  ON portfolio (user_id, algo_id) WHERE algo_id IS NOT NULL;

CREATE TABLE identity (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('google','github')),
  provider_subject TEXT NOT NULL,
  email_at_link    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subject)
);

CREATE TABLE position (
  portfolio_id UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL REFERENCES universe_symbol(symbol),
  quantity     NUMERIC(20,8) NOT NULL DEFAULT 0,
  avg_cost     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (portfolio_id, symbol),
  CHECK (quantity >= 0)
);

CREATE TABLE trade_order (
  id              UUID PRIMARY KEY,
  portfolio_id    UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL REFERENCES universe_symbol(symbol),
  side            TEXT NOT NULL CHECK (side IN ('buy','sell')),
  type            TEXT NOT NULL DEFAULT 'market' CHECK (type IN ('market')),
  quantity        NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
  status          TEXT NOT NULL
                    CHECK (status IN ('accepted','rejected','filled','cancelled')),
  reject_reason   TEXT,
  idempotency_key TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('human','algo')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, idempotency_key)
);

CREATE TABLE fill (
  id         UUID PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES trade_order(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL,
  side       TEXT NOT NULL CHECK (side IN ('buy','sell')),
  quantity   NUMERIC(20,8) NOT NULL CHECK (quantity > 0),
  price      BIGINT NOT NULL,
  filled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE valuation_snapshot (
  id              UUID PRIMARY KEY,
  portfolio_id    UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  taken_at        TIMESTAMPTZ NOT NULL,
  cash            BIGINT NOT NULL,
  positions_value BIGINT NOT NULL,
  equity          BIGINT NOT NULL,
  UNIQUE (portfolio_id, taken_at)
);
CREATE INDEX ON valuation_snapshot (taken_at);

CREATE TABLE leaderboard_row (
  taken_at     TIMESTAMPTZ NOT NULL,
  portfolio_id UUID NOT NULL REFERENCES portfolio(id) ON DELETE CASCADE,
  rank         INTEGER NOT NULL,
  equity       BIGINT NOT NULL,
  return_pct   DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (taken_at, portfolio_id)
);
CREATE INDEX ON leaderboard_row (taken_at, rank);
