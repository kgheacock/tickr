import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@tickr/shared-types';
import { client, ApiClientError } from '../api/client';

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
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => client.getMe(),
    retry: (_count, err) => {
      if (err instanceof ApiClientError && err.status === 401) return false;
      return _count < 2;
    },
    staleTime: 5 * 60 * 1_000,
  });

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
