import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  buildGitHubStartUrl,
  exchangeGitHubCode,
  randomPKCECodeVerifier,
  randomState,
} from '../../src/auth/github.js';

const REDIRECT_URI = 'https://tickr.local/api/v1/auth/github/callback';

beforeAll(() => {
  process.env['GITHUB_OAUTH_CLIENT_ID'] = 'gh-test-client';
  process.env['GITHUB_OAUTH_CLIENT_SECRET'] = 'gh-test-secret';
});

describe('buildGitHubStartUrl', () => {
  it('includes required OAuth parameters', async () => {
    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const url = await buildGitHubStartUrl(REDIRECT_URI, state, codeVerifier);

    expect(url.hostname).toBe('github.com');
    expect(url.searchParams.get('client_id')).toBe('gh-test-client');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('read:user');
  });

  it('state and codeVerifier are unique per call', async () => {
    const a = {
      state: randomState(),
      codeVerifier: randomPKCECodeVerifier(),
    };
    const b = {
      state: randomState(),
      codeVerifier: randomPKCECodeVerifier(),
    };
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('exchangeGitHubCode', () => {
  function makeFetch(
    tokenBody: object,
    userBody: object,
    emailsBody: object,
    tokenStatus = 200,
  ) {
    return vi.fn().mockImplementation((url: string) => {
      if (url === 'https://github.com/login/oauth/access_token') {
        return Promise.resolve(
          new Response(JSON.stringify(tokenBody), {
            status: tokenStatus,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url === 'https://api.github.com/user') {
        return Promise.resolve(
          new Response(JSON.stringify(userBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      if (url === 'https://api.github.com/user/emails') {
        return Promise.resolve(
          new Response(JSON.stringify(emailsBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
  }

  it('returns profile with email from primary verified address', async () => {
    const fetchImpl = makeFetch(
      { access_token: 'tok' },
      { id: 42, name: 'Alice Dev', login: 'alicedev' },
      [{ email: 'alice@example.com', primary: true, verified: true }],
    );

    const profile = await exchangeGitHubCode(
      'code',
      'verifier',
      REDIRECT_URI,
      fetchImpl,
    );

    expect(profile.sub).toBe('42');
    expect(profile.email).toBe('alice@example.com');
    expect(profile.emailVerified).toBe(true);
    expect(profile.name).toBe('Alice Dev');
  });

  it('falls back to login when name is null', async () => {
    const fetchImpl = makeFetch(
      { access_token: 'tok' },
      { id: 7, name: null, login: 'gh-bot' },
      [{ email: 'bot@example.com', primary: true, verified: true }],
    );

    const profile = await exchangeGitHubCode(
      'code',
      'verifier',
      REDIRECT_URI,
      fetchImpl,
    );

    expect(profile.name).toBe('gh-bot');
  });

  it('returns null email and emailVerified: false when no primary verified address', async () => {
    const fetchImpl = makeFetch(
      { access_token: 'tok' },
      { id: 5, name: 'NoVerified', login: 'noverified' },
      [
        { email: 'unverified@example.com', primary: true, verified: false },
        { email: 'secondary@example.com', primary: false, verified: true },
      ],
    );

    const profile = await exchangeGitHubCode(
      'code',
      'verifier',
      REDIRECT_URI,
      fetchImpl,
    );

    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
  });

  it('throws when the token endpoint returns a non-OK status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('Bad credentials', { status: 401 }));

    await expect(
      exchangeGitHubCode('bad-code', 'verifier', REDIRECT_URI, fetchImpl),
    ).rejects.toThrow('GitHub token exchange failed: 401');
  });

  it('throws when token response has no access_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'bad_verification_code' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      exchangeGitHubCode('bad-code', 'verifier', REDIRECT_URI, fetchImpl),
    ).rejects.toThrow('bad_verification_code');
  });
});
