-- ETF basket (item 17): named, reusable weighted basket of universe symbols.
-- An ETF key (e.g. "big7") is exposed as the synthetic handle "etf:big7".

CREATE TABLE etf (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  key         TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  base_value  BIGINT      NOT NULL DEFAULT 10000,  -- cents; index level at base_date
  base_date   DATE        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE etf_weight (
  etf_id  UUID         NOT NULL REFERENCES etf(id) ON DELETE CASCADE,
  symbol  TEXT         NOT NULL REFERENCES universe_symbol(symbol),
  weight  NUMERIC(12,8) NOT NULL CHECK (weight > 0),
  PRIMARY KEY (etf_id, symbol)
);
