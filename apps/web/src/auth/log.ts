/**
 * Dev-only console logging for the auth/logout sequence. No-ops in production
 * builds so the logs never ship.
 */
export function authLog(message: string, data?: unknown): void {
  if (!import.meta.env.DEV) return;
  if (data !== undefined) {
    // eslint-disable-next-line no-console
    console.log(`[auth] ${message}`, data);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[auth] ${message}`);
  }
}
