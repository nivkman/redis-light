// Lua scripts run atomically on the Redis server.

// Release a lock only if we still own it (token matches).
export const RELEASE_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

// Sliding-window rate limit on a sorted set.
// ARGV: now (ms), window (ms), limit, member id
// Returns: { allowed (1|0), count, oldest score in window }
export const RATE_LIMIT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window)
local count = redis.call('ZCARD', KEYS[1])
local allowed = 0
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', KEYS[1], window)
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')[2] or now
return { allowed, count, tonumber(oldest) }`;

// INCRBY that sets the TTL only when the key has none yet (fixed window).
// ARGV: amount, ttl (ms, 0 = none)
export const INCR_WITH_TTL = `
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 and redis.call('PTTL', KEYS[1]) == -1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return value`;
