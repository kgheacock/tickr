import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { client } from '../api/client';
import { clearDevLogin } from './devLogin';
import { authLog } from './log';

/**
 * Logs the user out and returns them to the landing page.
 *
 * Invalidating `['me']` is sufficient here only because AuthProvider's queryFn
 * resolves a post-logout 401 to `null` (logged out) instead of throwing — so
 * the refetch clears `user`. If getMe threw on 401 instead, neither invalidate
 * nor removeQueries would clear the stale user (see logoutCache.test.ts).
 */
export function useLogout(): () => Promise<void> {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  return useCallback(async () => {
    authLog('logout → start');
    // Clear the dev-login request first so AuthProvider doesn't immediately
    // re-establish a session (no-op when the bypass isn't in use).
    clearDevLogin();
    await client.logout();
    authLog('logout → POST /auth/logout done');
    await queryClient.invalidateQueries({ queryKey: ['me'] });
    authLog("logout → invalidated ['me'] (refetch resolves to null)");
    navigate('/', { replace: true });
    authLog("logout → navigate('/')");
  }, [queryClient, navigate]);
}
