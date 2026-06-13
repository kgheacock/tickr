if (process.env['ROLE'] !== 'worker') {
  throw new Error(
    `finnhub module imported outside the worker role (ROLE=${process.env['ROLE'] ?? 'unset'})`,
  );
}

export { finnhubGet, FinnhubRateLimitError } from './client.js';
export { acquire } from './bucket.js';
