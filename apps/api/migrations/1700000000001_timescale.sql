-- TimescaleDB extension + price_bar hypertable.
-- Kept separate because the extension must exist before create_hypertable.
-- In dev the extension is already enabled by compose/postgres-init/01-timescaledb.sql;
-- CREATE EXTENSION IF NOT EXISTS is a no-op in that case.

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE price_bar (
  symbol TEXT        NOT NULL REFERENCES universe_symbol(symbol),
  ts     TIMESTAMPTZ NOT NULL,
  open   BIGINT      NOT NULL,
  high   BIGINT      NOT NULL,
  low    BIGINT      NOT NULL,
  close  BIGINT      NOT NULL,
  volume NUMERIC(20,8),
  PRIMARY KEY (symbol, ts)
);

SELECT create_hypertable('price_bar', 'ts');
