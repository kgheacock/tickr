import { Readable } from 'node:stream';
import { requireEnv } from '../config.js';

const BASE = 'https://www.kaggle.com/api/v1';
const TIMEOUT_MS = 120_000;

export async function downloadDataset(
  slug: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<NodeJS.ReadableStream> {
  const username = requireEnv('KAGGLE_USERNAME');
  const apiKey = requireEnv('KAGGLE_API_KEY');
  const credential = Buffer.from(`${username}:${apiKey}`).toString('base64');

  const url = `${BASE}/datasets/download/${slug}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchFn(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { Authorization: `Basic ${credential}` },
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new Error(`Kaggle HTTP ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Kaggle response has no body');
  }

  return Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
}
