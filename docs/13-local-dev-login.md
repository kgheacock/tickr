# Local dev login (auth bypass)

Signing in normally requires completing the real Google OAuth flow. For local
development you can skip it with a **dev-only auth bypass** that mints a real
session — useful for working on the authed UI (Market, Strategy) and the logout
flow without an OAuth round-trip.

> ⚠️ This is a genuine backdoor: it grants a session to anyone who can reach the
> endpoint. It is gated so it can never run in production (see
> [Safety gating](#safety-gating)). Never enable it on a deployed environment.

## How to use it

1. Bring up the stack with the **dev** compose overlay (the default for
   `pnpm run dev`). The dev overlay sets `TICKR_DEV_AUTH=1` and
   `NODE_ENV=development`, which is what registers the route.
2. Open the app with the `?login=true` query parameter:

   ```
   https://local.tickr.keithheacock.com/?login=true
   ```

   The SPA detects the flag (only when `import.meta.env.DEV`), calls
   `POST /api/v1/auth/dev-login`, and refetches `/me`. You land authenticated as
   a synthetic admin user (`dev@local.tickr`).

   Add `&admin=false` to log in as a plain **player** instead of an admin —
   useful for exercising the invite-only, non-admin onboarding view (e.g. the
   gated "Start a League" CTA):

   ```
   https://local.tickr.keithheacock.com/?login=true&admin=false
   ```

   The choice sticks in `sessionStorage`; pass `&admin=true` (or clear it via
   sign-out) to go back to admin. It applies to the synthetic user only — when
   impersonating with `&email=`, you take on that account's own role.

3. **Sign out** uses the real logout path (`POST /auth/logout`), so you can
   exercise it normally. The dev-login flag is cleared on logout so you are not
   immediately signed back in.

The flag is persisted in `sessionStorage`, so it survives client-side
navigations (including the post-logout redirect that drops the query param).

### Quick check (no browser)

```bash
curl -i -X POST https://local.tickr.keithheacock.com/api/v1/auth/dev-login
# → HTTP/2 204 + Set-Cookie: tickr_sid=…; HttpOnly; Secure; SameSite=Lax

# Log in as a plain player instead of an admin:
curl -i -X POST https://local.tickr.keithheacock.com/api/v1/auth/dev-login \
  -H 'Content-Type: application/json' -d '{"admin":false}'
```

### Gotchas

- **Restart the API after enabling.** `TICKR_DEV_AUTH` / `NODE_ENV` are read at
  boot; the API container must be (re)started via the dev overlay or the route
  returns `404`. Reloading Vite is not enough.
- **Use the HTTPS dev domain, not `localhost:5173`.** The `tickr_sid` cookie is
  `Secure`, so plain-HTTP `localhost` may refuse to store it.

## Safety gating

The bypass is defended three independent ways, all defaulting closed:

1. **Code gate.** The route is registered only when
   `TICKR_DEV_AUTH === '1'` **and** `NODE_ENV !== 'production'`
   (`apps/api/src/roles/api.ts`).
2. **Environment.** Only `compose/docker-compose.dev.yml` sets `TICKR_DEV_AUTH=1`
   (+ `NODE_ENV=development`). The prod overlay sets `NODE_ENV=production` and
   never sets the flag.
3. **Deploy guard.** `scripts/deploy.sh` refuses to deploy if `TICKR_DEV_AUTH`
   is set to any non-empty value in the production secrets file.

Production SPA builds (`import.meta.env.DEV === false`) ignore `?login=true`
entirely, so the client half is inert there too.

## How it works

- **Server:** `apps/api/src/routes/auth/dev-login.ts` upserts an idempotent
  synthetic user (`provider_subject = 'dev-login'`) and mints a session +
  `tickr_sid` cookie, mirroring the OAuth callback.
- **Client:** `apps/web/src/auth/devLogin.ts` (flag detection) and
  `AuthProvider` (which performs the `dev-login` POST). `[auth]` console logs
  (`apps/web/src/auth/log.ts`) trace the sequence in dev.

See [`TODO/21-logout-fix-and-dev-auth.md`](../TODO/21-logout-fix-and-dev-auth.md)
for the original context (it was added alongside a logout cache-state fix).
