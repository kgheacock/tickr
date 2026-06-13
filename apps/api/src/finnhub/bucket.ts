import type { Redis } from 'ioredis';

export const BUCKET_KEY = 'finnhub:bucket';

// FINNHUB_RPS_LIMIT = sustained requests per minute (default: 60, the free-tier
// cap). Like Massive, we hard-cap burst to 1 token so requests spread evenly at
// 1 per (60_000/rateLimit) ms — at 60/min that is one request per second, which
// is safe whatever window model Finnhub uses (a fixed-minute window would let a
// 60-token burst exhaust the rest of that minute). A ~502-symbol post-close
// sweep therefore takes ~8–9 min, comfortably inside the post-close window.
const rateLimit = parseInt(process.env['FINNHUB_RPS_LIMIT'] ?? '60', 10);
const ratePerMs = rateLimit / 60_000;
const capacity = 1;

// Atomic continuous-refill token bucket. Time is passed from Node so vitest fake
// timers can drive bucket behaviour in unit tests.
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
