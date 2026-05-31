import type { Redis } from 'ioredis';

export const BUCKET_KEY = 'finnhub:bucket';

const capacity = parseInt(process.env['FINNHUB_RPS_LIMIT'] ?? '60', 10);
// tokens per millisecond  (60 tokens / 60 000 ms window)
const ratePerMs = capacity / 60_000;

// Atomic continuous-refill token bucket. Time is passed from Node so
// vitest fake timers can drive bucket behaviour in unit tests.
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
