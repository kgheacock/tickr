import {
  randomPKCECodeVerifier,
  calculatePKCECodeChallenge,
  randomState,
} from 'openid-client';
import { requireEnv } from '../config.js';

export { randomPKCECodeVerifier, randomState };

export interface GitHubProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export async function buildGitHubStartUrl(
  redirectUri: string,
  state: string,
  codeVerifier: string,
): Promise<URL> {
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', requireEnv('GITHUB_OAUTH_CLIENT_ID'));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

export async function exchangeGitHubCode(
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GitHubProfile> {
  const tokenRes = await fetchImpl(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: requireEnv('GITHUB_OAUTH_CLIENT_ID'),
        client_secret: requireEnv('GITHUB_OAUTH_CLIENT_SECRET'),
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      }),
    },
  );
  if (!tokenRes.ok) {
    throw new Error(`GitHub token exchange failed: ${tokenRes.status}`);
  }
  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenData.access_token) {
    throw new Error(
      `GitHub token exchange error: ${tokenData.error ?? 'unknown'}`,
    );
  }

  const ghHeaders = {
    Authorization: `Bearer ${tokenData.access_token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const [userRes, emailsRes] = await Promise.all([
    fetchImpl('https://api.github.com/user', { headers: ghHeaders }),
    fetchImpl('https://api.github.com/user/emails', { headers: ghHeaders }),
  ]);

  if (!userRes.ok)
    throw new Error(`GitHub user fetch failed: ${userRes.status}`);
  if (!emailsRes.ok)
    throw new Error(`GitHub emails fetch failed: ${emailsRes.status}`);

  const user = (await userRes.json()) as {
    id: number;
    name?: string | null;
    login: string;
  };

  const emails = (await emailsRes.json()) as Array<{
    email: string;
    primary: boolean;
    verified: boolean;
  }>;

  const primary = emails.find((e) => e.primary && e.verified);

  return {
    sub: String(user.id),
    email: primary?.email ?? null,
    emailVerified: !!primary,
    name: user.name ?? user.login,
  };
}
