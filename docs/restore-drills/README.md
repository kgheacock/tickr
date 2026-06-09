# Restore drills

Committed output of `scripts/restore-drill.sh`, one `<timestamp>.md` per run.
Each proves the most recent backup restored cleanly into a throwaway Postgres
container and passed basic sanity queries. Run quarterly — see
[../runbook.md §7](../runbook.md#7-restore-drill).
