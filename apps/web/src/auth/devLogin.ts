/**
 * Dev-only auth bypass (client half). Visiting any page with `?login=true` in
 * local dev marks the session as "dev login requested"; AuthProvider then calls
 * the server's gated `POST /auth/dev-login` to mint a REAL session, so the authed
 * UI and the real logout flow (POST /auth/logout → /me 401) can be exercised
 * without Google OAuth.
 *
 * Add `&email=<address>` to impersonate a specific account (e.g.
 * `?login=true&email=kheacock2@gmail.com`) — the server logs in as the existing
 * user with that email, or creates one if none exists. Omit it for the default
 * synthetic `dev@local.tickr` user.
 *
 * The synthetic user is an admin by default; add `&admin=false` to log in as a
 * plain player instead (e.g. to exercise the non-admin onboarding view).
 *
 * The request (and any impersonation email) is persisted in sessionStorage so it
 * survives client-side navigations that drop the query param (e.g. logout's
 * `navigate('/')`). Logout clears it so we don't immediately re-establish a session.
 *
 * Production builds (`import.meta.env.DEV === false`) never activate this.
 */
const STORAGE_KEY = 'tickr_dev_login';
const EMAIL_KEY = 'tickr_dev_login_email';
const ADMIN_KEY = 'tickr_dev_login_admin';

export function devLoginRequested(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === 'true') {
      sessionStorage.setItem(STORAGE_KEY, '1');
      const email = params.get('email')?.trim();
      if (email) {
        sessionStorage.setItem(EMAIL_KEY, email);
      }
      // Persist the admin choice only when explicitly given, so re-runs without
      // the param keep the last choice rather than silently resetting to admin.
      const admin = params.get('admin');
      if (admin !== null) {
        sessionStorage.setItem(ADMIN_KEY, admin === 'false' ? '0' : '1');
      }
    }
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** The account to impersonate for the pending dev login, or null for default. */
export function devLoginEmail(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    return sessionStorage.getItem(EMAIL_KEY);
  } catch {
    return null;
  }
}

/** Whether the pending dev login should be an admin (default true). */
export function devLoginAdmin(): boolean {
  if (!import.meta.env.DEV) return true;
  try {
    return sessionStorage.getItem(ADMIN_KEY) !== '0';
  } catch {
    return true;
  }
}

export function clearDevLogin(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(EMAIL_KEY);
    sessionStorage.removeItem(ADMIN_KEY);
  } catch {
    // sessionStorage unavailable — nothing to clear
  }
}
