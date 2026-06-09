import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { MeResponse } from '@tickr/shared-types';
import { client, ApiClientError } from '../api/client';
import { devLoginRequested } from './devLogin';
import { authLog } from './log';

interface AuthState {
  user: MeResponse['user'] | null;
  csrfToken: string | null;
  isLoading: boolean;
}

const AuthContext = createContext<AuthState>({
  user: null,
  csrfToken: null,
  isLoading: true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<MeResponse | null>({
    queryKey: ['me'],
    // Treat 401 as a real "logged out" state (null) rather than letting getMe
    // throw. This is load-bearing for logout: on a failed refetch React Query
    // keeps the last good data, so if 401 threw, the stale user would survive
    // and the logged-in view would stick until a refresh (neither invalidate
    // nor removeQueries fixes that — see logoutCache.test.ts). Returning null
    // makes logged-out a successful result that clears the user immediately.
    queryFn: async () => {
      authLog('queryFn → GET /me');
      try {
        return await client.getMe();
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) {
          authLog('queryFn → 401, resolving as logged out (null)');
          return null;
        }
        throw err;
      }
    },
    retry: (_count, err) => {
      // 401 no longer throws; this only guards transient non-auth failures.
      if (err instanceof ApiClientError && err.status === 401) return false;
      return _count < 2;
    },
    staleTime: 5 * 60 * 1_000,
  });

  // DEV-ONLY: when ?login=true was used, mint a real session via the server's
  // gated dev-login backdoor, then refetch /me. Runs once per mount.
  const devLoginAttempted = useRef(false);
  useEffect(() => {
    if (!devLoginRequested() || devLoginAttempted.current) return;
    devLoginAttempted.current = true;
    void (async () => {
      authLog('dev login requested → POST /auth/dev-login');
      try {
        await client.devLogin();
        authLog('dev login established → refetch /me');
        await queryClient.invalidateQueries({ queryKey: ['me'] });
      } catch (err) {
        authLog('dev login failed', err);
      }
    })();
  }, [queryClient]);

  useEffect(() => {
    authLog('state', { user: data?.user?.email ?? null, isLoading });
  }, [data?.user?.email, isLoading]);

  useEffect(() => {
    if (data?.csrfToken) {
      client.setCsrfToken(data.csrfToken);
    }
  }, [data?.csrfToken]);

  return (
    <AuthContext.Provider
      value={{
        user: data?.user ?? null,
        csrfToken: data?.csrfToken ?? null,
        isLoading,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
