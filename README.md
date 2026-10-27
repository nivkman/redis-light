# redis-light ⚡

[![npm version](https://img.shields.io/npm/v/redis-light)](https://www.npmjs.com/package/redis-light)

Redis in one line of code. JSON values with TTL, cache-aside `remember()`, distributed locks, rate limiting, pub/sub and namespaces — while keeping full access to [ioredis](https://github.com/redis/ioredis).

```js
import { connectRedis } from 'redis-light';

const redis = await connectRedis(process.env.REDIS_URL);

const user = await redis.remember(`user:${id}`, 60, () => db.users.findById(id));
```

## Features ✨

- ⚡ **One-line Connection** - URL, options object, or your existing ioredis instance
- 📦 **JSON by Default** - `set`/`get` objects, arrays, numbers and booleans — no `JSON.stringify` everywhere
- ⏱️ **TTL in Seconds** - One unit everywhere, decimals allowed (`ttl: 0.5` = 500 ms)
- 🧠 **Cache-aside `remember()`** - Concurrent callers share one call (no cache stampede in-process)
- 🔒 **Distributed Locks** - `lock(key, fn)` with token-safe release and auto-expiry
- 🚦 **Rate Limiting** - Sliding-window limiter, atomic in Lua
- 📣 **Pub/Sub with JSON** - `subscribe()` returns an unsubscribe function
- 🗂️ **Namespaces** - `redis.namespace('users')` scopes keys, channels and `clear()`
- 🔌 **Full ioredis Access** - `redis.client` is the raw client for anything else
- 📝 **Integrated Logging** - Uses [`logger-standard`](https://www.npmjs.com/package/logger-standard)
- 🎯 **TypeScript Types** - Bundled `.d.ts`, no build step
- 🪶 **Small** - Two dependencies: `ioredis` and `logger-standard`

## Installation

```bash
npm install redis-light
```

Requires Node.js 20+ and Redis 6+ (or any Redis-compatible server, e.g. Valkey, Dragonfly, KeyDB, Upstash).

## Quick Start

```js
import { connectRedis } from 'redis-light';

const redis = await connectRedis('redis://localhost:6379');

// JSON values with TTL
await redis.set('user:1', { name: 'Alice', plan: 'pro' }, { ttl: 60 });
await redis.get('user:1'); // { name: 'Alice', plan: 'pro' }

// Cache-aside
const report = await redis.remember('report:daily', 300, () => buildExpensiveReport());

// Distributed lock - only one process runs the job
await redis.lock('nightly-job', () => runNightlyJob());

// Rate limit - 100 requests per minute per IP
const { allowed, remaining, resetIn } = await redis.rateLimit(`ip:${ip}`, { limit: 100, window: 60 });

// Pub/Sub with JSON
const unsubscribe = await redis.subscribe('orders', (order) => console.log(order.id));
await redis.publish('orders', { id: 42, total: 99.9 });

await redis.disconnect();
```

Run the full example: `REDIS_URL=redis://localhost:6379 node example.js`

## API

### `connectRedis(config?, options?)`

Connects and resolves once Redis is ready. Rejects (and stops reconnecting) if the first connection fails, so a bad URL fails fast at startup.

| Parameter | Type | Default | Description |
|--------|------|---------|-------------|
| `config` | string \| object \| `Redis` | `process.env.REDIS_URL`, then `localhost:6379` | Connection URL, [ioredis options](https://redis.github.io/ioredis/interfaces/CommonRedisOptions.html), or an existing ioredis instance |
| `options.prefix` | string | `''` | Prefix every key and channel with `prefix:` |
| `options.service` | string | `'redis-light'` | Logger service name |
| `options.logLevel` | string | `'info'` | `'debug'`, `'info'`, `'warn'`, `'error'` |

```js
const redis = await connectRedis();                                   // REDIS_URL or localhost
const redis = await connectRedis('rediss://user:pass@host:6380');      // TLS
const redis = await connectRedis({ host: 'cache', port: 6379, db: 2 }); // ioredis options
const redis = await connectRedis(myIoredisClient, { prefix: 'my-app' });
```

### Key / Value

| Method | Returns | Description |
|--------|---------|-------------|
| `get(key)` | value \| `null` | Parsed JSON. Non-JSON values written by other tools come back as strings |
| `set(key, value, { ttl? })` | value | Stores `JSON.stringify(value)`. Throws on `undefined` |
| `getMany(keys)` | array | `MGET`, `null` for missing keys |
| `setMany({ key: value }, { ttl? })` | — | Atomic `MULTI` of `SET`s |
| `del(...keys)` | number | Number of keys deleted |
| `has(key)` | boolean | Key exists |
| `expire(key, ttl)` | boolean | Set a TTL. `false` if the key doesn't exist |
| `ttl(key)` | seconds \| `Infinity` \| `null` | `Infinity` = no expiry, `null` = no key |
| `incr(key, { by?, ttl? })` | number | Counter. `ttl` is set only when the counter has none (fixed window) |
| `keys(pattern?)` | string[] | `SCAN` (never `KEYS`), prefix stripped |
| `clear()` | number | Deletes every key in a namespace. Refuses on the root |

> Values go through JSON, so `Date` comes back as an ISO string and `Map`/`Set` are not preserved.

### `remember(key, ttl, fn)`

Returns the cached value, or runs `fn`, caches its result for `ttl` seconds and returns it.

```js
const user = await redis.remember(`user:${id}`, 60, () => db.users.findById(id));
await redis.forget(`user:${id}`); // invalidate after an update
```

- Concurrent `remember()` calls for the same key **in the same process** share one `fn()` call.
- `null` is cached; `undefined` is returned but not cached.
- If `fn` throws, nothing is cached and the error is rethrown.
- Pass `ttl` as `undefined` to cache with no expiry.

### `lock(key, fn, options?)`

Runs `fn` while holding a lock, then releases it — even when `fn` throws. Returns what `fn` returns.

```js
import { LockError } from 'redis-light';

try {
  await redis.lock('invoice:42', () => chargeCustomer(42), { ttl: 30, wait: 5 });
} catch (error) {
  if (error instanceof LockError) console.log('Someone else is charging this invoice');
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `ttl` | `10` | Seconds until the lock expires on its own, so a crashed process never holds it forever |
| `wait` | `0` | Seconds to keep retrying before throwing `LockError` |
| `retryDelay` | `0.1` | Seconds between retries |

Release is token-checked in Lua: if your lock expired and another process took it, you won't delete theirs. Keep `ttl` longer than `fn` takes. This is a single-Redis lock (`SET NX PX`), not Redlock across several independent masters.

### `rateLimit(key, { limit, window })`

Sliding-window limiter: at most `limit` calls per `window` seconds. Atomic, so it's correct across many app servers.

```js
app.use(async (req, res, next) => {
  const { allowed, remaining, resetIn } = await redis.rateLimit(`ip:${req.ip}`, { limit: 100, window: 60 });
  res.set('X-RateLimit-Remaining', remaining);
  if (!allowed) return res.status(429).set('Retry-After', Math.ceil(resetIn)).end();
  next();
});
```

Returns `{ allowed, remaining, resetIn }` (`resetIn` in seconds). Blocked calls are not counted.

### Pub/Sub

```js
const unsubscribe = await redis.subscribe('events', (message, channel) => {
  console.log(channel, message); // message is parsed JSON
});
await redis.publish('events', { type: 'signup', userId: 7 });
await unsubscribe();
```

A separate subscriber connection is opened on the first `subscribe()` and shared. A handler that throws is logged and doesn't affect other handlers.

### `namespace(name)`

Returns a scoped instance sharing the same connection. Namespaces nest.

```js
const sessions = redis.namespace('sessions');
await sessions.set(sessionId, data, { ttl: 3600 }); // key: "sessions:<id>"
await sessions.keys();                              // ['<id>', ...]
await sessions.clear();                             // deletes only sessions:*
```

### Everything Else

| Member | Description |
|--------|-------------|
| `client` | The raw ioredis client — hashes, streams, sorted sets, pipelines, anything |
| `prefix` | The current key prefix |
| `ping()` | `true` when Redis answers |
| `disconnect()` | Gracefully closes all connections |
| `Redis` (export) | The ioredis class |

```js
await redis.client.hset('user:1:profile', 'name', 'Alice');
await redis.client.xadd('events', '*', 'type', 'signup');
```

## Why redis-light? 🤔

Raw clients give you strings and commands. Every project then re-writes the same helpers: JSON wrapping, cache-aside, a lock that doesn't delete someone else's lock, a rate limiter that is actually atomic. `redis-light` is those helpers, tested against a real Redis, in a few hundred lines — and `redis.client` is always there when you need plain ioredis.

## Testing

```bash
npm test                                  # spawns a throwaway redis-server
REDIS_URL=redis://localhost:6379 npm test # or use your own
```

## License

MIT © Niv Kaufman
