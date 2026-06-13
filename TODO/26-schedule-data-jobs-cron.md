# 26 — Schedule data jobs in the worker cron

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/69) • **Depends on:** 22, 25
>
> Landed in two PRs: [#66](https://github.com/kgheacock/tickr/pull/66) (merged —
> startup/hourly backfill + M/W/Sat universe refresh) and
> [#69](https://github.com/kgheacock/tickr/pull/69) (the intraday live tail +
> off-hours gating that completes the DoD below).

## Goal

Make the data corpus **self-maintaining** instead of relying on manual
`pnpm backfill` / `pnpm metadata` runs, and keep prices as fresh as the free
Massive tier allows. Before this, the `worker` role only ran a one-shot backfill
at startup plus a single post-close session update; the universe reconcile
(Wikipedia) and the metadata/branding refresh had **no schedule at all**. That
left newly-added S&P 500 members without prices or logos until someone ran the
scripts by hand (exactly what the PR #64 prod deploy required). This is the open
follow-up from [item 25](25-universe-from-wikipedia.md).

## Rate-limit reality

The free Massive tier is **5 req/min** and intraday aggregates are one request
per symbol, so a full ~500-symbol sweep takes **~100 min**. A real-time corpus is
therefore not achievable on the free tier (it would need ~9 req/min just to touch
every symbol within the hour, ~34 for true 15-min freshness). The chosen approach
is a **best-effort continuous live tail** during market hours, with every other
Massive job pushed **off-hours** so it never competes for the daytime budget.

## Pre-reads

- [TODO/25-universe-from-wikipedia.md](25-universe-from-wikipedia.md) — the
  reconcile (`seedUniverse`, departure cap) this schedules.
- [TODO/22-ticker-metadata-and-branding.md](22-ticker-metadata-and-branding.md) —
  `runMetadataRefresh` (names + logos/icons) chained after the reconcile.
- `apps/api/src/jobs/scheduler.ts` — `registerScheduledJobs`, run by the worker
  role; the `withLock` helper and the shared `massive:bucket` token bucket.

## Steps

1. **Intraday live tail** — `cron.schedule('0 */5 * * * *')`, runs only when
   `isRegularSession(now)` (new DST-aware helper: weekdays 09:30–16:00 ET, NYSE
   holidays excluded). `SESSION_UPDATE_LOCK` serializes the 5-min firings into
   continuous back-to-back sweeps. Replaces the fixed 21:30 post-close cron: each
   sweep re-fetches a trailing multi-day window with `ON CONFLICT` inserts and
   stamps the EOD health signal, so bars a near-close sweep missed self-heal on
   the next session — no separate post-close pass needed.
2. **Off-hours backfill** — startup catch-up + hourly `cron.schedule('0 0 * * * *')`,
   both gated to **skip while `isRegularSession(now)`**. Hydrates members added by
   the reconcile; a no-op once the corpus is current.
3. **M/W/Sat universe refresh** — `cron.schedule('0 0 0 * * 1,3,6')` (00:00 UTC,
   off-hours): `seedUniverse()` (Wikipedia pull, **default 0.1 departure cap**)
   then `runMetadataRefresh()` **directly after**, under `massive:job:universe-refresh`.
4. **Lock TTL** — every Massive-job lock acquisition (intraday, backfill,
   universe refresh) uses a **6h TTL**. A ~100-min sweep under the old 30-min TTL
   would be lapped by the next 5-min firing and stack concurrent sweeps,
   multiplying spend. Released in `withLock`'s `finally` on normal completion, so
   the TTL is only a crash net.
5. **Tests** — `test/jobs/scheduler.test.ts` (node-cron + deps mocked) and
   `test/market/holidays.test.ts` (DST/edge cases for `isRegularSession`).

## Definition of done

- [x] Intraday live tail runs every 5 min **only during the regular session**,
      serialized by the session lock into continuous best-effort sweeps; the fixed
      post-close cron is removed (completeness self-heals via the trailing-window
      `ON CONFLICT` re-fetch).
- [x] Backfill (startup + hourly) is **gated off-hours** so it never spends the
      rate budget during market hours.
- [x] M/W/Sat cron runs the reconcile then the metadata refresh, in that order,
      under a dedicated lock; reconcile uses the default 0.1 cap (the one-time 0.2
      backlog clear is **not** baked into the schedule).
- [x] All Massive-job locks use a TTL longer than the longest plausible run, so a
      slow run can't be lapped by the next firing.
- [x] `isRegularSession` is DST-correct (America/New_York) and excludes weekends +
      holidays, with direct unit tests; scheduler test covers the schedules,
      session gating, ordering, and lock-held skip; typecheck + eslint clean.
- [ ] **Verify on prod:** after merge + redeploy, confirm the worker logs the new
      schedule, the live tail sweeps during market hours, and backfill/refresh run
      off-hours.

> **Known limitation (accepted):** best-effort only — at 5 req/min each symbol's
> tail can be up to ~one sweep (~100 min) stale. Closing this needs a higher
> `MASSIVE_RPS_LIMIT` (paid tier) or a smaller live-tail universe.

## Follow-on: dev escape hatch — `TICKR_DISABLE_REMOTE_JOBS` ([#82](https://github.com/kgheacock/tickr/pull/82))

`pnpm dev` brought up the worker, which registered all three external-data jobs
this item added (backfill, intraday sweep, universe refresh) — requiring a real
`MASSIVE_API_KEY` locally and burning the shared free-tier rate budget on every
dev boot. PR #82 gates those three behind a dev-only `TICKR_DISABLE_REMOTE_JOBS`
flag (default off), set on the dev worker in `docker-compose.dev.yml`, and
relaxes the `MASSIVE_API_KEY` requirement when it is on. The DB/Redis-only alerts
job still runs. `scripts/deploy.sh` refuses the flag in prod — set there it would
silently halt all data ingestion — mirroring the existing `TICKR_DEV_AUTH` guard.
Scheduler tests cover the flag-on path (alerts only, no Massive locks).
