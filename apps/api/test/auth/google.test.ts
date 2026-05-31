import { describe, it, expect, vi } from 'vitest';
import {
  Configuration,
  customFetch,
  randomPKCECodeVerifier,
  randomState,
  type CustomFetch,
} from 'openid-client';
import {
  buildGoogleStartUrl,
  exchangeGoogleCode,
} from '../../src/auth/google.js';

const FAKE_SERVER_METADATA = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
};

function makeTestConfig(mockFetch?: CustomFetch): Configuration {
  const config = new Configuration(
    FAKE_SERVER_METADATA,
    'test-client-id',
    'test-client-secret',
  );
  if (mockFetch) {
    config[customFetch] = mockFetch;
  }
  return config;
}

describe('buildGoogleStartUrl', () => {
  it('returns a URL with required OAuth params', async () => {
    process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'test-client-id';
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'test-secret';

    const config = makeTestConfig();
    const { url, state, codeVerifier } = await buildGoogleStartUrl(
      config,
      'https://tickr.local/api/v1/auth/google/callback',
    );

    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(state);
    expect(codeVerifier).toBeTruthy();
  });

  it('state and codeVerifier are unique per call', async () => {
    const config = makeTestConfig();
    const a = await buildGoogleStartUrl(config, 'https://example.com/cb');
    const b = await buildGoogleStartUrl(config, 'https://example.com/cb');
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('exchangeGoogleCode — ID token validation', () => {
  it('extracts profile from a valid token endpoint response', async () => {
    // Build a minimal fake ID token payload (not cryptographically signed —
    // openid-client skips signature verification for tokens received over TLS
    // direct-communication unless enableNonRepudiationChecks is used).
    const now = Math.floor(Date.now() / 1000);
    const fakeClaims = {
      iss: 'https://accounts.google.com',
      aud: 'test-client-id',
      sub: 'google-sub-12345',
      email: 'user@example.com',
      name: 'Test User',
      exp: now + 300,
      iat: now,
    };

    // Build a fake ID token (header.payload.signature — signature can be anything
    // because we are NOT calling enableNonRepudiationChecks).
    const fakeJwt = [
      Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fake' })).toString(
        'base64url',
      ),
      Buffer.from(JSON.stringify(fakeClaims)).toString('base64url'),
      'fakesig',
    ].join('.');

    const mockFetch: CustomFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'fake-access-token',
          token_type: 'Bearer',
          id_token: fakeJwt,
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const config = makeTestConfig(mockFetch);

    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const callbackUrl = new URL(
      'https://tickr.local/api/v1/auth/google/callback',
    );
    callbackUrl.searchParams.set('code', 'fake-code');
    callbackUrl.searchParams.set('state', state);

    const profile = await exchangeGoogleCode(
      config,
      callbackUrl,
      codeVerifier,
      state,
    );

    expect(profile.sub).toBe('google-sub-12345');
    expect(profile.email).toBe('user@example.com');
    expect(profile.name).toBe('Test User');
  });

  function makeTokenResponse(claims: Record<string, unknown>): Response {
    const fakeJwt = [
      Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fake' })).toString(
        'base64url',
      ),
      Buffer.from(JSON.stringify(claims)).toString('base64url'),
      'fakesig',
    ].join('.');
    return new Response(
      JSON.stringify({
        access_token: 'tok',
        token_type: 'Bearer',
        id_token: fakeJwt,
        expires_in: 3600,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('throws on wrong iss', async () => {
    const now = Math.floor(Date.now() / 1000);
    const mockFetch: CustomFetch = vi.fn().mockResolvedValue(
      makeTokenResponse({
        iss: 'https://evil.com',
        aud: 'test-client-id',
        sub: 'sub',
        exp: now + 300,
        iat: now,
      }),
    );
    const config = makeTestConfig(mockFetch);
    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const callbackUrl = new URL(
      'https://tickr.local/api/v1/auth/google/callback',
    );
    callbackUrl.searchParams.set('code', 'fake-code');
    callbackUrl.searchParams.set('state', state);
    await expect(
      exchangeGoogleCode(config, callbackUrl, codeVerifier, state),
    ).rejects.toThrow();
  });

  it('throws on wrong aud', async () => {
    const now = Math.floor(Date.now() / 1000);
    const mockFetch: CustomFetch = vi.fn().mockResolvedValue(
      makeTokenResponse({
        iss: 'https://accounts.google.com',
        aud: 'wrong-client-id',
        sub: 'sub',
        exp: now + 300,
        iat: now,
      }),
    );
    const config = makeTestConfig(mockFetch);
    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const callbackUrl = new URL(
      'https://tickr.local/api/v1/auth/google/callback',
    );
    callbackUrl.searchParams.set('code', 'fake-code');
    callbackUrl.searchParams.set('state', state);
    await expect(
      exchangeGoogleCode(config, callbackUrl, codeVerifier, state),
    ).rejects.toThrow();
  });

  it('throws on expired exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const mockFetch: CustomFetch = vi.fn().mockResolvedValue(
      makeTokenResponse({
        iss: 'https://accounts.google.com',
        aud: 'test-client-id',
        sub: 'sub',
        exp: now - 600,
        iat: now - 1200,
      }),
    );
    const config = makeTestConfig(mockFetch);
    const state = randomState();
    const codeVerifier = randomPKCECodeVerifier();
    const callbackUrl = new URL(
      'https://tickr.local/api/v1/auth/google/callback',
    );
    callbackUrl.searchParams.set('code', 'fake-code');
    callbackUrl.searchParams.set('state', state);
    await expect(
      exchangeGoogleCode(config, callbackUrl, codeVerifier, state),
    ).rejects.toThrow();
  });

  it('throws when the state does not match', async () => {
    const mockFetch: CustomFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'access_denied' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const config = makeTestConfig(mockFetch);
    const callbackUrl = new URL(
      'https://tickr.local/api/v1/auth/google/callback',
    );
    callbackUrl.searchParams.set('code', 'fake-code');
    callbackUrl.searchParams.set('state', 'wrong-state');

    await expect(
      exchangeGoogleCode(config, callbackUrl, 'verifier', 'expected-state'),
    ).rejects.toThrow();
  });
});
