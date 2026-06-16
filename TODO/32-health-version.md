# 32 — Report the root package.json version in `/health`

> **Status:** in review ([PR #90](https://github.com/kgheacock/tickr/pull/90)) • **Depends on:** 12
>
> **Delivered:** [PR #90](https://github.com/kgheacock/tickr/pull/90) —
> `apps/api/src/roles/api.ts`.

## Goal

Surface the deployed application version on the public health probe so
`GET /api/v1/health` (live at
https://tickr.keithheacock.com/api/v1/health) reports which build is
answering, alongside the existing `ok` flag and the commit SHA on `/meta`.

## The change

`GET /api/v1/health` returns `{ ok: true, version }`, where `version` is the
**root** `package.json` version:

- Read **once at module load** (not per request) from the workspace-root
  `package.json`, which the prod image bakes in at `/app/package.json` (see
  `apps/api/Dockerfile`), resolved relative to `import.meta.url`
  (`../../../../package.json` from `apps/api/src/roles/`).
- Only the `version` **string** is exposed — the rest of the manifest
  (`scripts`, `dependencies`, …) is never echoed onto this unauthenticated
  probe.
- Falls back to `'unknown'` if the file is missing/unreadable, mirroring the
  `/meta` endpoint's tone, so a read failure degrades the field instead of
  failing server boot.

> The root `package.json` version is currently `0.0.0`, so the field reads
> `"0.0.0"` today; it will reflect real values once the root manifest is bumped.

## Definition of done

- [x] `GET /api/v1/health` returns a `version` field sourced from the root
      `package.json`, while keeping the existing `ok: true`.
- [x] Only the version string is exposed — the full manifest is never echoed
      onto the unauthenticated probe.
- [x] The file is read once at module load (no per-request fs hit) and degrades
      to `'unknown'` on read/parse failure rather than failing boot.
- [x] Path resolution verified to resolve to the repo-root `package.json` and
      read its version; `pnpm --filter @tickr/api typecheck` passes, Prettier +
      ESLint clean.
