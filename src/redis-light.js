import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { serialize, deserialize, toMs } from './serialize.js';

export class LockError extends Error {
  constructor(key) {
    super(`redis-light: could not acquire lock "${key}"`);
    this.name = 'LockError';
    this.key = key;
  }
}

function ttlArgs(ttl) {
  return ttl ? ['PX', toMs(ttl)] : [];
}

function fromPttl(ms) {
  if (ms === -2) return null;
  if (ms === -1) return Infinity;
  return ms / 1000;
}

export class RedisLight {
  #core = null;
  #prefix = '';

  // core is shared by every namespace: { client, logger, pubsub, inflight }
  constructor(core, prefix = '') {
    this.#core = core;
    this.#prefix = prefix;
  }

  get client() {
    return this.#core.client;
  }

  get prefix() {
    return this.#prefix;
  }

  namespace(name) {
    return new RedisLight(this.#core, `${this.#prefix}${name}:`);
  }

  // ---- Key / value -------------------------------------------------------

  async get(key) {
    return deserialize(await this.client.get(this.#key(key)));
  }

  async set(key, value, { ttl } = {}) {
    await this.client.set(this.#key(key), serialize(value), ...ttlArgs(ttl));
    return value;
  }

  async getMany(keys) {
    if (keys.length === 0) return [];
    const raws = await this.client.mget(keys.map((key) => this.#key(key)));
    return raws.map(deserialize);
  }

  async setMany(entries, { ttl } = {}) {
    const multi = this.client.multi();
    for (const [key, value] of Object.entries(entries)) {
      multi.set(this.#key(key), serialize(value), ...ttlArgs(ttl));
    }
    await multi.exec();
  }

  async del(...keys) {
    if (keys.length === 0) return 0;
    return this.client.del(keys.map((key) => this.#key(key)));
  }

  async has(key) {
    return (await this.client.exists(this.#key(key))) === 1;
  }

  async expire(key, ttl) {
    return (await this.client.pexpire(this.#key(key), toMs(ttl))) === 1;
  }

  async ttl(key) {
    return fromPttl(await this.client.pttl(this.#key(key)));
  }

  async incr(key, { by = 1, ttl } = {}) {
    const ms = ttl ? toMs(ttl) : 0;
    return this.client.redisLightIncr(this.#key(key), by, ms);
  }

  async keys(pattern = '*') {
    const found = await this.#scan(`${this.#prefix}${pattern}`);
    return found.map((key) => key.slice(this.#prefix.length));
  }

  // Deletes every key in this namespace. Refuses on the root to avoid wiping the database.
  async clear() {
    if (!this.#prefix) throw new Error('redis-light: clear() only works on a namespace');
    const found = await this.#scan(`${this.#prefix}*`);
    if (found.length > 0) await this.client.unlink(found);
    return found.length;
  }

  // ---- Cache-aside -------------------------------------------------------

  async remember(key, ttl, fn) {
    const fullKey = this.#key(key);
    const raw = await this.client.get(fullKey);
    if (raw !== null) return deserialize(raw);
    return this.#dedupe(fullKey, () => this.#compute(fullKey, ttl, fn));
  }

  async forget(key) {
    return (await this.del(key)) === 1;
  }

  // ---- Distributed lock --------------------------------------------------

  async lock(key, fn, { ttl = 10, wait = 0, retryDelay = 0.1 } = {}) {
    const fullKey = this.#key(`lock:${key}`);
    const token = randomUUID();
    await this.#acquire(fullKey, token, ttl, Date.now() + wait * 1000, retryDelay);
    try {
      return await fn();
    } finally {
      await this.client.redisLightRelease(fullKey, token);
    }
  }

  // ---- Rate limiting -----------------------------------------------------

  async rateLimit(key, { limit, window }) {
    const now = Date.now();
    const ms = toMs(window);
    const member = `${now}-${randomUUID()}`;
    const [allowed, count, oldest] = await this.client.redisLightRateLimit(
      this.#key(`ratelimit:${key}`), now, ms, limit, member);
    return { allowed: allowed === 1, remaining: Math.max(0, limit - count), resetIn: (oldest + ms - now) / 1000 };
  }

  // ---- Pub/Sub -----------------------------------------------------------

  async publish(channel, message) {
    return this.#core.pubsub.publish(this.#key(channel), message);
  }

  async subscribe(channel, handler) {
    return this.#core.pubsub.subscribe(this.#key(channel), handler);
  }

  // ---- Lifecycle ---------------------------------------------------------

  async ping() {
    return (await this.client.ping()) === 'PONG';
  }

  async disconnect() {
    await this.#core.pubsub.close();
    await this.client.quit();
    this.#core.logger.info('Redis connection closed');
  }

  // ---- Internals ---------------------------------------------------------

  #key(key) {
    return `${this.#prefix}${key}`;
  }

  async #compute(fullKey, ttl, fn) {
    const value = await fn();
    if (value !== undefined) await this.client.set(fullKey, serialize(value), ...ttlArgs(ttl));
    return value;
  }

  // Concurrent remember() calls for the same key in this process share one fn() call.
  #dedupe(fullKey, run) {
    const { inflight } = this.#core;
    if (!inflight.has(fullKey)) inflight.set(fullKey, run().finally(() => inflight.delete(fullKey)));
    return inflight.get(fullKey);
  }

  async #acquire(fullKey, token, ttl, deadline, retryDelay) {
    while (true) {
      if (await this.client.set(fullKey, token, 'PX', toMs(ttl), 'NX')) return;
      if (Date.now() + retryDelay * 1000 > deadline) throw new LockError(fullKey);
      await sleep(retryDelay * 1000);
    }
  }

  async #scan(match) {
    const found = [];
    for await (const batch of this.client.scanStream({ match, count: 500 })) found.push(...batch);
    return [...new Set(found)];
  }
}
