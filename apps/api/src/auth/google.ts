import {
  discovery,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  randomPKCECodeVerifier,
  calculatePKCECodeChallenge,
  randomState,
  customFetch,
  type Configuration,
  type CustomFetch,
} from 'openid-client';
import { requireEnv } from '../config.js';

export { randomPKCECodeVerifier, randomState };

export interface GoogleProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

let _config: Configuration | undefined;

export async function buildGoogleConfig(
  fetchImpl?: CustomFetch,
): Promise<Configuration> {
  if (_config && !fetchImpl) return _config;
  const opts = fetchImpl ? { [customFetch]: fetchImpl } : {};
  const config = await discovery(
    new URL('https://accounts.google.com'),
    requireEnv('GOOGLE_OAUTH_CLIENT_ID'),
    requireEnv('GOOGLE_OAUTH_CLIENT_SECRET'),
    undefined,
    opts,
  );
  if (!fetchImpl) _config = config;
  return config;
}

export async function buildGoogleStartUrl(
  config: Configuration,
  redirectUri: string,
): Promise<{ url: URL; state: string; codeVerifier: string }> {
  const state = randomState();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const url = buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { url, state, codeVerifier };
}

export async function exchangeGoogleCode(
  config: Configuration,
  callbackUrl: URL,
  codeVerifier: string,
  expectedState: string,
): Promise<GoogleProfile> {
  const tokens = await authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error('No ID token claims returned');
  return {
    sub: claims.sub,
    email: typeof claims['email'] === 'string' ? claims['email'] : null,
    emailVerified: claims['email_verified'] === true,
    name: typeof claims['name'] === 'string' ? claims['name'] : null,
  };
}
