-- Fantasy Street, FS-14 item 3 (create-league flow): label an invite with the
-- email of the person it was created for, so a league can be stood up with its
-- intended human members in one step. NULL = an unaddressed share-link invite
-- (the original FS-01 behaviour, unchanged).
--
-- Actual email *delivery* is not wired yet (no mail transport in the API) — the
-- row is created and the link surfaced; sending is a TODO (see 14-polish.md).

ALTER TABLE fs_invite ADD COLUMN email TEXT;
