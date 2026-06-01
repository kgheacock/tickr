if (process.env['ROLE'] !== 'worker') {
  throw new Error(
    `massive module imported outside the worker role (ROLE=${process.env['ROLE'] ?? 'unset'})`,
  );
}

export { massiveGet, MassiveRateLimitError } from './client.js';
export { acquire } from './bucket.js';
