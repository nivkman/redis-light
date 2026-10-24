// Run: REDIS_URL=redis://localhost:6379 node example.js
import { connectRedis } from './src/index.js';

const redis = await connectRedis(process.env.REDIS_URL, { prefix: 'example' });

// JSON values with TTL
await redis.set('user:1', { name: 'Alice', plan: 'pro' }, { ttl: 60 });
console.log('user:', await redis.get('user:1'));

// Cache-aside: the slow function runs once, then comes from Redis
const slowReport = async () => {
  await new Promise((resolve) => setTimeout(resolve, 500));
  return { total: 1234 };
};
console.time('first');
await redis.remember('report', 30, slowReport);
console.timeEnd('first');
console.time('cached');
await redis.remember('report', 30, slowReport);
console.timeEnd('cached');

// Rate limiting: 3 requests per 10 seconds
for (let i = 1; i <= 4; i++) {
  const { allowed, remaining } = await redis.rateLimit('ip:127.0.0.1', { limit: 3, window: 10 });
  console.log(`request ${i}:`, allowed ? 'allowed' : 'blocked', `(${remaining} left)`);
}

// Distributed lock: only one process runs the job at a time
const result = await redis.lock('nightly-job', async () => 'job done');
console.log(result);

// Pub/Sub with JSON
const unsubscribe = await redis.subscribe('orders', (order) => console.log('new order:', order));
await redis.publish('orders', { id: 42, total: 99.9 });
await new Promise((resolve) => setTimeout(resolve, 100));
await unsubscribe();

await redis.clear();
await redis.disconnect();
