# 15 — Migrate from npm workspaces to pnpm

> **Status:** done • **PR:** https://github.com/kgheacock/tickr/pull/13 • **Depends on:** —

## Goal

Replace npm with pnpm as the package manager across the monorepo. npm has a
known workspace hoisting bug ([npm/cli#4828](https://github.com/npm/cli/issues/4828))
that silently drops optional OS/CPU-scoped dependencies (e.g.
`@rolldown/binding-darwin-arm64`, `lefthook-darwin-arm64`) on clean installs.
This causes `vitest` and `lefthook` to fail until manually patched. pnpm
handles optional dependencies and workspace hoisting correctly and eliminates
the need for the manual workaround.

## Background

Two packages are affected by the npm bug:

| Package | Why optional | Symptom |
|---|---|---|
| `@rolldown/binding-darwin-arm64` | vitest v4 native bundler | `Cannot find native binding` — tests fail to start |
| `lefthook-darwin-arm64` | git hook runner | `Can't find lefthook in PATH` — pre-commit hooks silent |

Current workaround (fragile, must be repeated after every clean install):
```bash
npm install @rolldown/binding-darwin-arm64@1.0.3 --no-save
npm install lefthook@1.13.6 lefthook-darwin-arm64@1.13.6 --no-save
```

## Steps

1. **Install pnpm.** Add to `.nvmrc`-adjacent tooling; install globally for
   the active Node version:
   ```bash
   npm install -g pnpm
   # or: brew install pnpm
   ```

2. **Generate `pnpm-workspace.yaml`.** Replace npm workspaces config:
   ```yaml
   packages:
     - 'apps/*'
     - 'packages/*'
   ```
   Remove the `"workspaces"` key from root `package.json`.

3. **Import lockfile.** Let pnpm generate a fresh lockfile from existing
   `package.json` files:
   ```bash
   rm package-lock.json
   pnpm install
   ```
   Commit `pnpm-lock.yaml`; delete `package-lock.json`.

4. **Update `package.json` scripts** that use npm workspace flags:
   - `"npm run -ws --if-present typecheck"` → `"pnpm -r --if-present run typecheck"`
   - `"prepare": "lefthook install || true"` stays as-is (pnpm runs prepare).

5. **Update `lefthook.yml`** (if it uses `npm` in any commands) to use `pnpm`.

6. **Update `.env.example` / docs** that mention `npm install` → `pnpm install`.

7. **Update `TODO/12-deployment.md`** and any CI references to use `pnpm`.

8. **Verify:**
   ```bash
   rm -rf node_modules apps/api/node_modules packages/*/node_modules
   pnpm install
   pnpm run typecheck
   pnpm -C apps/api test
   ```
   Confirm `@rolldown/binding-darwin-arm64` and `lefthook-darwin-arm64` are
   present in `node_modules` without manual intervention.

## Definition of done

- [x] `pnpm install` from a clean checkout installs all optional deps correctly
      (no manual `npm install --no-save` needed).
- [x] `pnpm -C apps/api test` runs all tests green.
- [x] `git commit` triggers the lefthook pre-commit hook (format + lint).
- [x] `package-lock.json` deleted; `pnpm-lock.yaml` committed.
- [x] No `npm` references remain in CI, Makefile, or deployment scripts.
