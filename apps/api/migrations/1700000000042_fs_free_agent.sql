-- Fantasy Street — immediate free-agent transactions (buy/sell).
--
-- The roster table (migration 031) constrained acquired_via to the three write
-- paths that existed then: draft, waiver, trade. Buying an unowned stock off the
-- waiver wire (or selling one back) is a fourth, immediate path — add 'free_agent'
-- to the CHECK so those rows are legal. Sell is a plain DELETE and needs no value.

ALTER TABLE fs_roster_entry
  DROP CONSTRAINT fs_roster_entry_acquired_via_check;

ALTER TABLE fs_roster_entry
  ADD CONSTRAINT fs_roster_entry_acquired_via_check
  CHECK (acquired_via IN ('draft', 'waiver', 'trade', 'free_agent'));
