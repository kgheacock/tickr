-- Runs on first init of the postgres data volume only. To re-run, drop the
-- tickr-pg-data volume: `docker compose down -v && docker compose up`.
CREATE EXTENSION IF NOT EXISTS timescaledb;
