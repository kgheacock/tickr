# 05 — Auth (Google + GitHub SSO)

tickr has **no local passwords**. Authentication is delegated entirely to Google
and GitHub via OAuth 2.0 / OIDC. This doc defines the flows, session model, and
the contracts; nothing here is implemented.

## 1. Why SSO-only

- No password storage, reset flows, or credential-breach surface to own.
- Both providers are ubiquitous for the likely audience (developers + general).
- A user may link **both** providers to one tickr account.

## 2. Providers

| Provider | Protocol | Identity we trust |
|---|---|---|
| Google | OIDC (OAuth 2.0 + ID token) | `sub` claim (stable subject) |
| GitHub | OAuth 2.0 (+ user API) | numeric user `id` (stable subject) |

> GitHub is OAuth 2.0 (not full OIDC); we fetch the profile via its user API and
> use the immutable account `id` as the subject. Google provides an OIDC ID token
> whose `sub` we use directly. In both cases the **provider subject**, not email,
> is the stable key — emails can change.

## 3. Sign-in flow (authorization code)

```
Browser            tickr API                 Provider (Google/GitHub)
  │  GET /auth/google/start                       │
  │ ───────────────▶ │                            │
  │                  │ create state+PKCE, store    │
  │                  │ 302 to provider authorize   │
  │ ◀─────────────── │ ──────────────────────────▶ │
  │  (user consents at provider)                  │
  │ ◀───────────────────────────────────────────── 302 back with ?code&state
  │  GET /auth/google/callback?code&state          │
  │ ───────────────▶ │                            │
  │                  │ verify state, exchange code │
  │                  │ ──────────────────────────▶ │ (token endpoint)
  │                  │ ◀────────────────────────── │ tokens / ID token
  │                  │ validate ID token / fetch    │
  │                  │ profile; upsert user+identity│
  │                  │ create session; Set-Cookie   │
  │ ◀─────────────── │ 302 to app                   │
```

Key requirements:

- **Login-CSRF protection** via two complementary mechanisms:
  1. `state` parameter — generated server-side, single-use, stored in Redis with 10-min TTL.
  2. `tickr_oauth_attempt` cookie — set at `/start` (host-only, `SameSite=Lax`, HMAC-signed, TTL ≤ 10 min); verified and cleared at `/callback`. Binds the flow to the initiating browser; prevents an attacker from completing their own flow in a victim's browser.
- **PKCE** (`code_challenge`/`code_verifier`) for the auth-code exchange.
- **ID token validation** (Google): signature against provider JWKS, `iss`,
  `aud` (our client id), `exp`. GitHub: validate token by calling its user API
  over TLS.
- **Account resolution:** look up `identity(provider, providerSubject)`. If found
  → that user. If not → create a new `user` + `identity` (or, if logged in and
  hitting the *link* flow, attach to the current user).

## 4. Account linking

A logged-in user can link the other provider via `POST /auth/link/:provider/start`.
The callback attaches a new `identity` row to the existing `user`. Linking is
refused if the provider-subject is already attached to a different user
(`409 CONFLICT`).

**Account-merge policy:** if the new provider's verified email matches an existing
user's email, attach the identity to that user automatically. If emails don't
match (or the provider withholds email), create a distinct account; an admin can
merge manually on request.

## 5. Sessions

- On success, the server issues an **opaque session** referenced by an
  **HTTP-only, Secure, SameSite=Lax** cookie. No tokens in JS-readable storage.
- Session record (server-side; Redis and/or Postgres) holds `userId`, issue time,
  expiry, and a rotating CSRF token for state-changing requests if needed.
- Provider access/refresh tokens are **not** needed after login (we don't act on
  the user's behalf at Google/GitHub) and should be discarded post-profile-fetch.

```ts
interface Session {
  id: string;            // opaque; the cookie value (or a handle to it)
  userId: string;
  createdAt: string;
  expiresAt: string;
}
```

- **Expiry / refresh:** sliding expiry; **30-day absolute maximum**. Each
  authenticated request extends the session by the sliding window (e.g. 7 days),
  but a session issued more than 30 days ago is always expired regardless.
- **Logout** (`POST /auth/logout`) deletes the server-side session and clears the
  cookie.

## 6. Authorization (roles)

Two roles in v1 (see `user.role` in [02-data-model](02-data-model.md)):

| Role | Can |
|---|---|
| `player` | Join seasons, trade own portfolios, manage own algos |
| `admin` | Everything player can, plus all `/admin/*` (themes, seasons, seed bots, ops) |

- The admin (you) is provisioned out-of-band (env-configured allowlist of
  provider subjects or a one-time bootstrap), **not** via a public endpoint.
- Endpoint-level checks enforce role; ownership checks ensure a player only
  touches their own portfolios/algos.

## 7. Secrets & config

- OAuth **client IDs** and **client secrets** for both providers are server-side
  env config; never shipped to the browser.
- Redirect URIs are registered per environment (dev/prod) at each provider.
- See [08-deployment](08-deployment.md) for where these live on the VPS.

## 8. Threats addressed

| Threat | Mitigation |
|---|---|
| Login-CSRF | `state` param (single-use, server-stored) + `tickr_oauth_attempt` cookie (HMAC-signed, host-only, SameSite=Lax, TTL 10 min) |
| Authorization-code interception | PKCE |
| Token forgery (Google) | JWKS signature + `iss`/`aud`/`exp` validation |
| Session theft via XSS | HTTP-only cookie (token never in JS) |
| Cross-site request forgery on actions | SameSite cookie + CSRF token on mutations |
| Account takeover via email change | Key on provider subject, not email |

## 9. Open auth decisions

- Account-merge / duplicate-signup policy (§4).
- Absolute session lifetime + refresh strategy (§5).
- Admin bootstrap mechanism specifics (§6).

See [09-open-questions](09-open-questions.md).
