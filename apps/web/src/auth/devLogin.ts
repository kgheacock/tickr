/**
 * Dev-only auth bypass (client half). Visiting any page with `?login=true` in
 * local dev marks the session as "dev login requested"; AuthProvider then calls
 * the server's gated `POST /auth/dev-login` to mint a REAL session, so the authed
 * UI and the real logout flow (POST /auth/logout → /me 401) can be exercised
 * without Google OAuth.
 *
 * The request is persisted in sessionStorage so it survives client-side
 * navigations that drop the query param (e.g. logout's `navigate('/')`). Logout
 * clears it so we don't immediately re-establish a session.
 *
 * Production builds (`import.meta.env.DEV === false`) never activate this.
 */
const STORAGE_KEY = 'tickr_dev_login';

export function devLoginRequested(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === 'true') {
      sessionStorage.setItem(STORAGE_KEY, '1');
    }
    return sessionStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearDevLogin(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // sessionStorage unavailable — nothing to clear
  }
}
