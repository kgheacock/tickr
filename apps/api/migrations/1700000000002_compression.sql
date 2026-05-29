-- Compress price_bar chunks older than 7 days; segment by symbol for
-- query locality on the hot path (WHERE symbol=$1 AND ts BETWEEN $2 AND $3).

ALTER TABLE price_bar SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'symbol'
);

SELECT add_compression_policy('price_bar', INTERVAL '7 days');
