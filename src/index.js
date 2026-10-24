import { once } from 'node:events';
import { Redis } from 'ioredis';
import { Logger } from 'logger-standard';
import { RedisLight, LockError } from './redis-light.js';
import { PubSub } from './pubsub.js';
import { RELEASE_LOCK, RATE_LIMIT, INCR_WITH_TTL } from './scripts.js';

function createLogger(options) {
  const service = options.service || 'redis-light';
  const logLevel = options.logLevel || 'info';
  return new Logger({ service, logLevel });
}

function createClient(config) {
  if (config instanceof Redis) return config;
  if (typeof config === 'string') return new Redis(config, { lazyConnect: true });
  return new Redis({ ...config, lazyConnect: true });
}

function attachEvents(client, logger) {
  client.on('ready', () => logger.info(`Connected to Redis ${client.options.host}:${client.options.port}`));
  client.on('reconnecting', () => logger.warn('Reconnecting to Redis...'));
  client.on('error', (error) => logger.error(`Redis error: ${error.message}`));
}

// defineCommand caches each script with EVALSHA instead of resending it every call.
function defineScripts(client) {
  client.defineCommand('redisLightRelease', { numberOfKeys: 1, lua: RELEASE_LOCK });
  client.defineCommand('redisLightRateLimit', { numberOfKeys: 1, lua: RATE_LIMIT });
  client.defineCommand('redisLightIncr', { numberOfKeys: 1, lua: INCR_WITH_TTL });
}

// Accepts a fresh lazy client or an existing ioredis instance that is still connecting.
async function connect(client, logger) {
  if (client.status === 'ready') return;
  try {
    await (client.status === 'wait' ? client.connect() : once(client, 'ready'));
  } catch (error) {
    client.disconnect();
    logger.error(`Could not connect to Redis: ${error.message}`);
    throw error;
  }
}

export async function connectRedis(config = process.env.REDIS_URL, options = {}) {
  const logger = createLogger(options);
  const client = createClient(config);
  attachEvents(client, logger);
  defineScripts(client);
  await connect(client, logger);
  const core = { client, logger, pubsub: new PubSub(client, logger), inflight: new Map() };
  return new RedisLight(core, options.prefix ? `${options.prefix}:` : '');
}

export { RedisLight, LockError, Redis };
