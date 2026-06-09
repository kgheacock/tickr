# 21 — Logout cache fix + dev auth bypass

> **Status:** [in review](https://github.com/kgheacock/tickr/pull/44) • **Depends on:** 04, 11, 12
>
> Retroactive record (written after the work) of a debugging session that
> fixed a stuck logout and, to reproduce it locally without Google OAuth,
> added a dev-only server-side auth bypass. Captured here so the rationale
> survives without the original conversation.

## Problem

On logout the server session was cleared correctly (`POST /auth/logout` →
`204`, then `GET /me` → `401` — confirmed via a HAR capture), but the SPA kept
showing the logged-in view until a manual refresh.

**Root cause (client-side only).** Auth state is derived entirely from the
`['me']` React Query cache (`AuthProvider`). `getMe()` threw on `401`, so after
logout the refetch errored — and React Query **keeps the last successful data on
a failed refetch**. The stale `user` survived, so `RequireAuth`/`LandingPage`
never flipped.

Two "obvious" fixes were tried and **both proved insufficient** by a unit test:
`invalidateQueries(['me'])` and `removeQueries(['me'])` both end in a `401`
refetch that retains the stale user. See `apps/web/src/auth/logoutCache.test.ts`
(two regression cases pin this).

## Fix

- `AuthProvider` `queryFn` now catches `401` and resolves to `null` (logged
  out) instead of throwing. "Logged out" becomes a **successful data state**, so
  the user clears immediately. `useLogout` then just calls `client.logout()` +
  `invalidateQueries(['me'])` + `navigate('/')`.
- Verified with a no-DOM `QueryObserver` test (`logoutCache.test.ts`): the
  buggy paths are asserted as regressions; the 401→null path flips to logged
  out. This is the durable verifier — `tsc`/lint could not catch the bug.

## Dev auth bypass (to reproduce authed flows without Google OAuth)

- **Server:** `POST /api/v1/auth/dev-login` (`apps/api/src/routes/auth/dev-login.ts`)
  mints a **real** session + `tickr_sid` cookie for a synthetic admin user
  (`provider_subject = 'dev-login'`, idempotent). Mirrors the OAuth callback's
  session/cookie handling.
- **Gating (defaults closed, three layers):**
  1. Registered only when `TICKR_DEV_AUTH === '1'` **and** `NODE_ENV !==
     'production'` (`apps/api/src/roles/api.ts`).
  2. The dev compose overlay sets `TICKR_DEV_AUTH=1` + `NODE_ENV=development`;
     the prod overlay sets `NODE_ENV=production` and never sets the flag.
  3. `scripts/deploy.sh` refuses to deploy if `TICKR_DEV_AUTH` is set to any
     non-empty value in the prod secrets file.
- **Client:** visiting any page with `?login=true` in dev (`import.meta.env.DEV`)
  persists the request in `sessionStorage`; `AuthProvider` then POSTs
  `/auth/dev-login` and refetches `/me`. `useLogout` clears the flag so we don't
  auto-relogin. Never active in production builds.
- `[auth]` dev-only console logs (`apps/web/src/auth/log.ts`) trace the sequence.

## Incidental

- Bumped `apps/web` to **Vite 8** (latest stable) + `@vitejs/plugin-react` 6 so
  `vitest` 4 is compatible; added a `test` script. Prod web image base is
  `node:22-alpine`, which satisfies Vite 8's `>=22.12.0`.

## Definition of done

- [x] Logout clears the view without a refresh (proven by `logoutCache.test.ts`).
- [x] `POST /auth/dev-login` returns `204` + `Set-Cookie: tickr_sid` (curled on
      the live HTTPS dev domain).
- [x] Bypass cannot reach prod: server double-gate + deploy-script guard +
      compose env (grep pattern unit-checked).
- [x] `apps/web` test / typecheck / lint / build green on Vite 8.

## Not covered / follow-ups

- The component/router layer (`useAuth → RequireAuth/LandingPage`) is trivial
  derivation and was read, not rendered in a test (no DOM test stack in
  `apps/web`).
- `apps/web` prod Docker image build was not run with Vite 8 — confirm before
  the next deploy (item 12).
