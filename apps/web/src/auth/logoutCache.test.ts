import { describe, it, expect } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import type { MeResponse } from '@tickr/shared-types';

// Reproduces AuthProvider's ['me'] query lifecycle through a logout WITHOUT a
// browser. AuthProvider derives `user` from this query's `data`; the logged-in
// view sticks iff the observer keeps exposing a user after logout. We drive a
// real QueryObserver (the same primitive useQuery wraps) and assert what the
// component would see.

class Unauthorized extends Error {
  status = 401;
  constructor() {
    super('unauthorized');
  }
}

const ME: MeResponse = {
  user: {
    id: '00000000-0000-0000-0000-000000000000',
    displayName: 'Dev User',
    email: 'dev@local.tickr',
    role: 'admin',
    createdAt: new Date(0).toISOString(),
  },
  identities: [],
  csrfToken: 'x',
};

/** Mirrors AuthProvider's useQuery options. `getMe` is swapped to simulate the
 *  server: returns the user while "logged in", throws 401 once logged out. */
function makeObserver(
  qc: QueryClient,
  getMe: () => Promise<MeResponse>,
  opts: { treat401AsLoggedOut: boolean },
) {
  return new QueryObserver<MeResponse | null>(qc, {
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await getMe();
      } catch (err) {
        if (opts.treat401AsLoggedOut && err instanceof Unauthorized)
          return null;
        throw err;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1_000,
  });
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('logout cache behavior (AuthProvider ["me"] query)', () => {
  // Both of the "obvious" cache fixes FAIL while getMe throws on 401: after the
  // cache is cleared/invalidated the active observer immediately recreates and
  // refetches ['me'], that refetch 401s, and React Query keeps the last good
  // data on a failed refetch — so the stale user survives. Verified empirically.
  it('REGRESSION: invalidateQueries leaves the stale user when getMe throws on 401', async () => {
    const qc = new QueryClient();
    let loggedIn = true;
    const getMe = async () => {
      if (!loggedIn) throw new Unauthorized();
      return ME;
    };
    const observer = makeObserver(qc, getMe, { treat401AsLoggedOut: false });
    const unsub = observer.subscribe(() => {});

    await observer.refetch();
    expect(observer.getCurrentResult().data?.user.email).toBe(
      'dev@local.tickr',
    );

    loggedIn = false;
    await qc.invalidateQueries({ queryKey: ['me'] });
    await settle();

    expect(observer.getCurrentResult().data?.user ?? null).not.toBeNull();
    unsub();
  });

  it('REGRESSION: removeQueries ALSO leaves the stale user when getMe throws on 401', async () => {
    const qc = new QueryClient();
    let loggedIn = true;
    const getMe = async () => {
      if (!loggedIn) throw new Unauthorized();
      return ME;
    };
    const observer = makeObserver(qc, getMe, { treat401AsLoggedOut: false });
    const unsub = observer.subscribe(() => {});

    await observer.refetch();
    expect(observer.getCurrentResult().data?.user.email).toBe(
      'dev@local.tickr',
    );

    loggedIn = false;
    qc.removeQueries({ queryKey: ['me'] });
    await settle();

    // removeQueries is NOT enough — the recreated query 401s and retains data.
    expect(observer.getCurrentResult().data?.user ?? null).not.toBeNull();
    unsub();
  });

  it('FIX: treating 401 as null makes logout flip to logged-out (the shipped fix)', async () => {
    const qc = new QueryClient();
    let loggedIn = true;
    const getMe = async () => {
      if (!loggedIn) throw new Unauthorized();
      return ME;
    };
    const observer = makeObserver(qc, getMe, { treat401AsLoggedOut: true });
    const unsub = observer.subscribe(() => {});

    await observer.refetch();
    expect(observer.getCurrentResult().data?.user.email).toBe(
      'dev@local.tickr',
    );

    loggedIn = false;
    await qc.invalidateQueries({ queryKey: ['me'] });
    await settle();

    expect(observer.getCurrentResult().data?.user ?? null).toBeNull();
    unsub();
  });
});
