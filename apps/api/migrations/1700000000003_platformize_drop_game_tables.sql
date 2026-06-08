-- Platformize (item 16): drop the game-only tables. The platform core
-- (app_user, identity, universe_symbol, price_bar) is left untouched.
--
-- Dropped in FK-safe order (referencing tables before their targets):
--   leaderboard_row, valuation_snapshot → portfolio
--   fill                                → trade_order
--   trade_order, position               → portfolio, universe_symbol
--   portfolio                           → app_user, algo
--   algo                                → app_user

DROP TABLE IF EXISTS leaderboard_row;
DROP TABLE IF EXISTS valuation_snapshot;
DROP TABLE IF EXISTS fill;
DROP TABLE IF EXISTS trade_order;
DROP TABLE IF EXISTS position;
DROP TABLE IF EXISTS portfolio;
DROP TABLE IF EXISTS algo;
