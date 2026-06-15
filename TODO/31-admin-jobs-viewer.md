# 31 — Admin jobs viewer (web)

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/87) • **Depends on:** 10, 21, 29

## Goal

An admin-only, **view-only** window onto the scheduled worker jobs and their
last-run status — parallel to the [admin log viewer](21-admin-log-viewer.md).
The log viewer answers "what happened"; this answers "did each job run, when,
and did it succeed". No SSH, no reading cron from the source — and strictly
read-only (no run/trigger controls).

## Context / constraints

- **Worker → api process boundary.** Jobs run in the `ROLE=worker` process but
  the page is served by the `ROLE=api` process, so the status must live in shared
  Redis, not an in-process map — same pattern as the cross-process metrics in
  [item 10](10-observability-and-admin.md) (`metrics/redis.ts`). Each job gets a
  hash (last start/finish/outcome/duration/error + lifetime run/fail/skip
  counters) plus a short-lived "running" marker with a TTL crash-net so a crashed
  worker doesn't read as forever-running.
- **Track by job name, not lock key.** `SESSION_UPDATE_LOCK` backs both the
  intraday sweep and the Saturday catch-up; `SCORING_LOCK` backs both the weekly
  settle and provisional scoring. Lock-based attribution would light the wrong
  row, so status is keyed by a stable per-job `name`.
- **Single instrumentation seam.** All 12 jobs except the lock-less alert check
  funnel through the scheduler's `withLock`; instrument there (plus a direct wrap
  for the alert check) rather than at 13 call sites, leaving each job's gating
  (off-hours, holiday-skip, `quietSkip`, TTLs) untouched. Status writes are
  best-effort — a Redis hiccup in the observability path must never break the job
  it observes.
- **Static registry as source of truth.** The job list is static (not derived
  from what got `cron.schedule`d) so a remote job still lists — as "never run" —
  under `TICKR_DISABLE_REMOTE_JOBS`. `JobName` is derived from the registry, so a
  typo'd call-site name is a compile error, not a job silently stuck on "never
  ran".
- **Reuse `/admin/ops` as the data source.** The page polls the existing
  `/admin/ops` (extended with `jobs[]`) rather than a new endpoint; the read
  degrades to `[]` on a Redis error so the log viewer's worst-lag chip (item 29),
  which polls the same endpoint, can never 500.
- **Skips don't mask the last real run.** A busy-skip (lock held) increments a
  skip counter and stamps `lastSkipAt`, but never overwrites `lastOutcome` — for
  the intraday sweep most firings are expected skips.

## Steps (as built)

1. **Job status layer** (`jobs/status.ts`). Static `JOB_DEFS` registry + canonical
   `JOB_LOCKS`; `recordJobStart` / `recordJobResult` / `recordJobSkip` /
   `readJobStatuses` over a per-job Redis hash + TTL running marker; `JobName`
   union derived from the registry.
2. **Instrument the scheduler** (`jobs/scheduler.ts`). `withLock` takes a job
   `name` and records start/result/skip via a shared `recordedRun` helper; the
   lock-less alert check is wrapped directly. Lock keys now come from the registry
   so the two layers can't drift.
3. **`jobs[]` on `/admin/ops`** (`routes/admin/ops.ts` + `openapi.yaml`). Added a
   `JobStatus` schema and `jobs` array to `OpsResponse`; the route includes
   `readJobStatuses`, degrading to `[]` on error. Types regenerated.
4. **`/admin/jobs` page** (`routes/admin/jobs.ts`). Self-contained, admin-gated,
   terminal-style HTML mirroring the log viewer; polls `/admin/ops` every 10s and
   renders the jobs table (running / ok / error / never pills, last-run relative
   time, duration, runs/fails/skips, inline error). Cross-linked with the log
   viewer both ways.

## Files

- `apps/api/src/jobs/status.ts` _(new — registry + Redis recording)_
- `apps/api/src/jobs/scheduler.ts` _(instrument the withLock seam + alert check)_
- `apps/api/src/routes/admin/jobs.ts` _(new — the HTML page)_
- `apps/api/src/routes/admin/ops.ts` _(`jobs[]` field, degrades to `[]`)_
- `apps/api/src/routes/admin/logs.ts` _(reciprocal "jobs →" header link)_
- `apps/api/src/roles/api.ts` _(register the route)_
- `packages/shared-types/openapi.yaml` _(`JobStatus` + `OpsResponse.jobs`; regenerated `openapi.gen.ts`)_
- `apps/api/test/jobs/status.test.ts` _(new)_, `apps/api/test/observability/ops.test.ts` _(jobs[] assertion)_

## Entry point

`https://tickr.keithheacock.com/api/v1/admin/jobs` — requires an admin session.

## Definition of done

- [x] `/admin/jobs` lists every scheduled worker job with its cadence and last-run
      status (running / ok / error / never-run), last-run time, duration, and
      lifetime runs/fails/skips, polled from `/admin/ops`.
- [x] Status is recorded in shared Redis from the worker process and read by the
      api process; jobs are tracked by name, so jobs sharing a lock stay distinct.
- [x] Instrumentation lives in the single `withLock` seam (+ the lock-less alert
      check); job gating/TTL/`quietSkip` semantics are unchanged and status writes
      are best-effort (can't break the job).
- [x] The job registry is static and the source of truth; `JobName` is derived
      from it so a typo'd call-site name fails to compile.
- [x] `OpsResponse` gains a `JobStatus[] jobs` field in `openapi.yaml` (types
      regenerated); the read degrades to `[]` so it can't 500 the shared endpoint.
- [x] The page is **view-only** — no run/trigger/retry controls.
- [x] Tests cover the status record→read round trip (running marker, skip vs.
      outcome, error truncation, registry/lock consistency) and that `jobs[]`
      survives the `/admin/ops` route; `tsc --noEmit`, eslint, prettier, and
      `pnpm lint:openapi` clean.

## Deferred (not in this slice)

- **Next-run time.** `node-cron` exposes no next-fire, so the page shows the cron
  expression + human cadence rather than a computed next-run; adding a cron parser
  is its own follow-on.
- **Run history.** Only the last run is kept (one hash per job); a per-run history
  table was rejected to avoid the main-vs-FS migration-numbering split for no
  current requirement.
