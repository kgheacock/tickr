# 04 — Auth (SSO + sessions)

> **Status:** pending • **Depends on:** 02, 03

## Goal

Implement Google + GitHub SSO with HTTP-only cookie sessions per
[docs/05-auth.md](../docs/05-auth.md). Provision the system user + admin
allowlist on first boot. Auto-create a portfolio on first sign-in so the
player can trade immediately.

## Pre-reads

- [docs/05-auth.md](../docs/05-auth.md) — flows, threat table, session model.
- [docs/02-data-model.md §2.1, §2.2](../docs/02-data-model.md#21-app_user)
  — `app_user` and `identity`.
- [docs/04-game-mechanics.md §1.1, §1.2](../docs/04-game-mechanics.md#11-player-onboarding)
  — onboarding + system-user seed for the `index` bot.

## Steps

1. **Provider clients.**
   - `apps/api/src/auth/google.ts` — `openid-client` against
     `https://accounts.google.com/.well-known/openid-configuration`.
   - `apps/api/src/auth/github.ts` — manual OAuth2 against
     `https://github.com/login/oauth/*` + `https://api.github.com/user`.
2. **Auth-code + PKCE flow per provider.**
   - `GET /auth/:provider/start` — generate `state` + `code_verifier`,
     store in Redis with TTL 10 min keyed by `state`, 302 to provider's
     authorize URL.
   - `GET /auth/:provider/callback?code&state` — verify `state`, exchange
     code (with PKCE `code_verifier`), validate ID token (Google) or fetch
     `/user` (GitHub), upsert `app_user` + `identity`, create session.
3. **Sessions.** Server-side opaque sessions in Redis keyed by random 32-byte
   token. Cookie: `tickr_sid`, `HttpOnly`, `Secure`, `SameSite=Lax`, scoped
   to root path. Sliding expiry (extend by 7 d on each request) capped at
   30 d absolute.
4. **`/me` endpoint.** Returns `MeResponse` from
   [docs/03-api.md §2](../docs/03-api.md#2-auth--session) including the
   caller's `portfolioId`. Auto-creates a portfolio on first call if none
   exists (cash = `100_000_000`, `algo_id = NULL`).
5. **`POST /auth/logout`.** Deletes the Redis session and clears the cookie.
6. **Account linking.** `POST /auth/link/:provider/start` and the callback
   attach a new `identity` row to the current user. Reject `409 CONFLICT`
   if the provider-subject already belongs to a different user.
7. **Account merge policy.** On first sign-in via a *new* provider whose
   verified email matches an existing `app_user.email`, attach the
   identity to that user instead of creating a new one. Decision per
   [docs/09-open-questions.md AU1](../docs/09-open-questions.md).
8. **Admin bootstrap.** On worker startup, read `ADMIN_BOOTSTRAP` (a
   comma-separated list of `provider:subject` pairs, e.g.
   `google:1234567890`). For each, upsert an `app_user` with `role='admin'`
   and an `identity` row. Idempotent.
9. **System user seed.** Same startup hook seeds a reserved system user
   (`id = '00000000-0000-0000-0000-000000000001'`, `role='admin'`,
   `display_name='system'`, no identities). The `index` bot in item 07
   owns its algo + portfolio through this user.
10. **CSRF.** Add a CSRF token (rotated per session) required on all
    state-changing requests; client reads from `GET /me`. Server validates
    header `X-CSRF-Token`.
11. **Tests.** Unit-test ID-token validation (signature, `iss`, `aud`,
    `exp`); integration-test the full flow against a mocked provider via
    `nock`.

## Files to create

- `apps/api/src/auth/google.ts`
- `apps/api/src/auth/github.ts`
- `apps/api/src/auth/session.ts`
- `apps/api/src/auth/middleware.ts` (cookie → session lookup → req.user)
- `apps/api/src/auth/csrf.ts`
- `apps/api/src/routes/auth/*.ts`
- `apps/api/src/routes/me.ts`
- `apps/api/src/bootstrap/admin.ts`
- `apps/api/src/bootstrap/system-user.ts`
- `apps/api/test/auth/*.test.ts`

## Definition of done

- [ ] Fresh user signs in via Google, lands authenticated; `GET /me`
      returns the user + a freshly-created portfolio id.
- [ ] Same user links GitHub via `/auth/link/github/start`; `/me` shows
      both identities.
- [ ] Two distinct provider subjects with the same verified email auto-link
      to one `app_user` (AU1).
- [ ] Provisioned admin (via `ADMIN_BOOTSTRAP`) returns `role: "admin"` in
      `/me`.
- [ ] Session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`; not readable
      from JS.
- [ ] Logout deletes the Redis session; subsequent `GET /me` returns 401.
- [ ] Session older than 30 d is rejected even if the sliding window would
      otherwise extend it.
- [ ] System user row exists after worker startup; row count after two
      boots is unchanged (idempotent).
