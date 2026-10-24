import { Redis, RedisOptions } from 'ioredis';

export { Redis };

/** Seconds. Decimals allowed (0.5 = 500 ms). */
export type Seconds = number;

export interface ConnectOptions {
  /** Logger service name (default: 'redis-light'). */
  service?: string;
  /** 'debug' | 'info' | 'warn' | 'error' (default: 'info'). */
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Prefix every key and channel with `${prefix}:`. */
  prefix?: string;
}

export interface LockOptions {
  /** Lock expiry, so a crashed process never holds it forever (default: 10). */
  ttl?: Seconds;
  /** How long to keep retrying before throwing LockError (default: 0). */
  wait?: Seconds;
  /** Delay between retries (default: 0.1). */
  retryDelay?: Seconds;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until a slot frees up. */
  resetIn: Seconds;
}

export class LockError extends Error {
  key: string;
}

export class RedisLight {
  /** The underlying ioredis client - full Redis access. */
  readonly client: Redis;
  readonly prefix: string;

  namespace(name: string): RedisLight;

  get<T = any>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, options?: { ttl?: Seconds }): Promise<T>;
  getMany<T = any>(keys: string[]): Promise<(T | null)[]>;
  setMany(entries: Record<string, unknown>, options?: { ttl?: Seconds }): Promise<void>;
  del(...keys: string[]): Promise<number>;
  has(key: string): Promise<boolean>;
  expire(key: string, ttl: Seconds): Promise<boolean>;
  /** Seconds left, Infinity when the key has no expiry, null when it does not exist. */
  ttl(key: string): Promise<Seconds | null>;
  incr(key: string, options?: { by?: number; ttl?: Seconds }): Promise<number>;
  keys(pattern?: string): Promise<string[]>;
  clear(): Promise<number>;

  remember<T>(key: string, ttl: Seconds | undefined, fn: () => T | Promise<T>): Promise<T>;
  forget(key: string): Promise<boolean>;

  lock<T>(key: string, fn: () => T | Promise<T>, options?: LockOptions): Promise<T>;
  rateLimit(key: string, options: { limit: number; window: Seconds }): Promise<RateLimitResult>;

  publish(channel: string, message: unknown): Promise<number>;
  subscribe<T = any>(channel: string, handler: (message: T, channel: string) => void | Promise<void>): Promise<() => Promise<void>>;

  ping(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export function connectRedis(config?: string | RedisOptions | Redis, options?: ConnectOptions): Promise<RedisLight>;
