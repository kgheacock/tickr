# 26 — Schedule data jobs in the worker cron

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/66) • **Depends on:** 22, 25

## Goal

Make the data corpus **self-maintaining** instead of relying on manual
`pnpm backfill` / `pnpm metadata` runs. Before this, the `worker` role only ran a
one-shot backfill at startup; the universe reconcile (Wikipedia) and the
metadata/branding refresh had **no schedule at all** — they only ran via the
bootstrap entrypoints. That left newly-added S&P 500 members without prices or
logos until someone ran the scripts by hand (exactly what the PR #64 prod deploy
required). This is the open follow-up from
[item 25](25-universe-from-wikipedia.md).

## Pre-reads

- [TODO/25-universe-from-wikipedia.md](25-universe-from-wikipedia.md) — the
  reconcile (`seedUniverse`, departure cap) this schedules.
- [TODO/22-ticker-metadata-and-branding.md](22-ticker-metadata-and-branding.md) —
  `runMetadataRefresh` (names + logos/icons) chained after the reconcile.
- `apps/api/src/jobs/scheduler.ts` — `registerScheduledJobs`, run by the worker
  role; existing session-update + alerts crons and the `withLock` helper.

## Steps

1. **Hourly backfill** — `cron.schedule('0 0 * * * *')` → `runBackfill` under the
   existing `massive:job:backfill` lock. No-op when the corpus is current (the job
   self-terminates with nothing pending); does real work after the reconcile adds
   members. Startup catch-up backfill retained.
2. **M/W/Sat universe refresh** — `cron.schedule('0 0 0 * * 1,3,6')` (00:00 UTC
   Mon/Wed/Sat): `seedUniverse()` (Wikipedia pull, **default 0.1 departure cap**)
   then `runMetadataRefresh()` **directly after**, under a new
   `massive:job:universe-refresh` lock.
3. **Lock TTL fix** — a large catch-up backfill runs >1h (the 76-symbol prod run
   took 1h20m). The shared 30-min TTL would expire mid-run and let the next hourly
   firing start a second concurrent backfill. Add a 6h TTL for the backfill +
   universe-refresh locks (released in `finally` on normal completion, so the TTL
   is only a crash net); session-update keeps its tight 30-min TTL.
4. **Tests** — `test/jobs/scheduler.test.ts` (node-cron mocked).

## Definition of done

- [x] Hourly price-backfill cron registered; startup catch-up retained.
- [x] M/W/Sat cron runs the universe reconcile then the metadata refresh, in that
      order, under a dedicated lock; reconcile uses the default 0.1 cap (the
      one-time 0.2 backlog clear is **not** baked into the schedule).
- [x] Backfill + universe-refresh locks use a TTL longer than the longest
      plausible run, so a slow run can't be lapped by the next hourly firing.
- [x] `test/jobs/scheduler.test.ts` covers the cron expressions, the
      reconcile→metadata ordering, the long-TTL locking, and the lock-held skip;
      typecheck + eslint clean.
- [ ] **Verify on prod:** after merge + redeploy, confirm the worker logs the new
      schedule and the next M/W/Sat firing reconciles + refreshes without a manual
      run.
