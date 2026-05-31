import { Redis } from 'ioredis';
import { requireEnv } from './config.js';

let _redis: Redis | undefined;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(requireEnv('REDIS_URL'), { lazyConnect: false });
  }
  return _redis;
}
