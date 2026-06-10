# 23 — Admin log viewer: deploy commit + backfill status

> **Status:** [done](https://github.com/kgheacock/tickr/pull/57) • **Depends on:** 10, 21
>
> Small enhancement to the admin log viewer (item 21): surface the **deployed
> commit** (linked to GitHub) and a **minimal backfill status bar** in the page
> header, so an admin watching the logs can see *which build* is running and
> whether the universe backfill is idle without leaving the page.

## Goal

Add at-a-glance metadata to `GET /api/v1/admin/logs`:

1. an **active-commit chip** showing the running build's SHA, linking to its
   GitHub commit page; and
2. a **backfill status bar** that reflects the universe backfill progress
   surfaced by `GET /admin/ops` (item 10).

## Context / constraints

- **Commit is constant per process → inject it server-side.** The `/admin/logs`
  handler already has `process.env['TICKR_COMMIT']` in hand, so the commit chip
  is baked into the HTML at render time — no client fetch, no "loading…" flash,
  and the feature stays self-contained in the logs route (no dependency on the
  SPA or `openapi.gen.ts`). The backfill bar genuinely changes, so it is polled
  client-side.
- **Two non-linkable sentinels.** `TICKR_COMMIT` is the deployed SHA in prod
  (`scripts/deploy.sh` sets `TICKR_IMAGE_TAG="$(git rev-parse …)"`), but the
  prod compose fallback is `local` and the dev fallback is `unknown`. Only a
  real SHA (`/^[0-9a-f]{7,40}$/i`) renders a GitHub link; the sentinels render a
  dimmed, non-linkable label rather than a dead link.
- **One repo-URL constant, spelled `kgheacock/tickr`.** The project has prior
  history of a `ticker`-vs-`tickr` typo in a prod string, so the link base is a
  single named constant.
- **Keep the backfill bar honest.** `backfillRemaining` is the primary signal
  (green/idle at 0, amber/"N remaining" otherwise). `jobQueueDepth` is the
  "backfill / session-update" lock count, so it is surfaced as general *jobs
  active*, not labeled as backfill.
- **Poll cadence.** `/admin/ops` is **not** at `logLevel: 'warn'` (unlike
  `logs.json`), so each poll appears as an info line in the very feed below. The
  bar polls every 20s (~3/min) to keep that noise low.

## Steps (as built)

1. **Expose the deployed commit** (`roles/api.ts`, `compose/docker-compose.prod.yml`).
   `GET /api/v1/meta` returns `{ commit }` from `TICKR_COMMIT`; prod compose
   passes `TICKR_COMMIT: ${TICKR_IMAGE_TAG:-local}` so the value always matches
   the running image.
2. **Commit chip** (`routes/admin/logs.ts`). `commitChipHtml()` + a `GITHUB_REPO_URL`
   constant and `COMMIT_SHA_RE` guard; the static page string becomes
   `renderLogViewer(commit)` so the chip is injected at render time (HTML-escaped).
3. **Backfill status bar** (`routes/admin/logs.ts`). Inline JS polls
   `/api/v1/admin/ops` every 20s and renders a colored-dot chip from
   `backfillRemaining` (+ `jobQueueDepth` as job activity); failures degrade to a
   muted "backfill ?".

## Entry point

`https://tickr.keithheacock.com/api/v1/admin/logs` — requires an admin session
(unchanged from item 21).

## Files

- `apps/api/src/routes/admin/logs.ts` _(commit chip, render fn, backfill bar)_
- `apps/api/src/roles/api.ts` _(`GET /api/v1/meta`)_
- `compose/docker-compose.prod.yml` _(`TICKR_COMMIT` passthrough)_

## Definition of done

- [x] `GET /admin/logs` header shows the active deploy commit; a real SHA links
      to the GitHub commit page, and the `local` / `unknown` sentinels render as
      a non-linkable label.
- [x] The commit is injected server-side from `TICKR_COMMIT` (no client fetch /
      flash), HTML-escaped, via a single repo-URL constant.
- [x] A minimal backfill status bar polls `/admin/ops` and reflects
      `backfillRemaining` (idle vs. N remaining) without mislabeling
      `jobQueueDepth` as backfill; poll failures degrade gracefully.
- [x] `GET /api/v1/meta` returns the deployed commit; prod compose passes
      `TICKR_COMMIT` so `/meta` and the chip match the running image.
- [x] Existing logs-route tests still pass; `tsc --noEmit`, prettier, and eslint
      are clean.
