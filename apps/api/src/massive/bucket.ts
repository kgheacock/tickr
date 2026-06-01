import type { Redis } from 'ioredis';

export const BUCKET_KEY = 'massive:bucket';

// MASSIVE_RPS_LIMIT = sustained requests per minute (default: 5, confirmed by probe).
// Massive free tier uses a fixed-minute window, so bursting all tokens at once
// exhausts the window for the rest of that minute. Hard-cap burst to 1 token so
// requests are spread evenly at 1 per (60_000/rateLimit) ms — safe for any window model.
const rateLimit = parseInt(process.env['MASSIVE_RPS_LIMIT'] ?? '5', 10);
const ratePerMs = rateLimit / 60_000;
const capacity = 1;

const LUA = `
local key        = KEYS[1]
local now        = tonumber(ARGV[1])
local cap        = tonumber(ARGV[2])
local rate       = tonumber(ARGV[3])

local data       = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens     = tonumber(data[1])
local last_refill = tonumber(data[2])

if tokens == nil then
  tokens     = cap
  last_refill = now
end

local elapsed   = now - last_refill
local new_tokens = math.min(cap, tokens + elapsed * rate)

if new_tokens >= 1.0 then
  redis.call('HMSET', key, 'tokens', tostring(new_tokens - 1.0), 'last_refill', tostring(now))
  redis.call('PEXPIRE', key, 120000)
  return 0
else
  local wait_ms = math.ceil((1.0 - new_tokens) / rate)
  redis.call('HMSET', key, 'tokens', tostring(new_tokens), 'last_refill', tostring(now))
  redis.call('PEXPIRE', key, 120000)
  return wait_ms
end
`;

export async function acquire(redis: Redis, key = BUCKET_KEY): Promise<void> {
  for (;;) {
    const waitMs = (await redis.eval(
      LUA,
      1,
      key,
      String(Date.now()),
      String(capacity),
      String(ratePerMs),
    )) as number;
    if (waitMs === 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }
}
