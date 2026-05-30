import { createHmac, timingSafeEqual } from 'node:crypto';

export function signState(state: string, key: string): string {
  return createHmac('sha256', key).update(state).digest('hex');
}

export function verifyState(
  state: string,
  signature: string,
  key: string,
): boolean {
  const expected = signState(state, key);
  try {
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}
