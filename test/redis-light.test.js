import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectRedis, LockError, Redis } from '../src/index.js';
import { startRedis } from './helpers.js';

let server;
let redis;
let root;

before(async () => {
  server = await startRedis();
  root = await connectRedis(server.url, { logLevel: 'error' });
  redis = root.namespace(`test-${process.pid}`);
});

after(async () => {
  await redis.clear();
  await root.disconnect();
  await server.stop();
});

test('connects with one line and exposes the raw ioredis client', async () => {
  assert.equal(await redis.ping(), true);
  assert.ok(redis.client instanceof Redis);
});

test('accepts an existing ioredis instance', async () => {
  const own = new Redis(server.url);
  const db = await connectRedis(own, { logLevel: 'error' });
  assert.equal(await db.ping(), true);
  await db.disconnect();
});

test('rejects with a clear error when Redis is unreachable', async () => {
  await assert.rejects(connectRedis('redis://127.0.0.1:1', { logLevel: 'error' }));
});

test('set/get round-trips JSON values', async () => {
  const user = { id: 1, name: 'Niv', tags: ['a', 'b'], active: true };
  await redis.set('user:1', user);
  assert.deepEqual(await redis.get('user:1'), user);
  await redis.set('n', 42);
  assert.equal(await redis.get('n'), 42);
  await redis.set('nothing', null);
  assert.equal(await redis.get('nothing'), null);
});

test('get returns null for missing keys and raw strings for non-JSON values', async () => {
  assert.equal(await redis.get('missing'), null);
  await redis.client.set(`${redis.prefix}plain`, 'hello world');
  assert.equal(await redis.get('plain'), 'hello world');
});

test('set refuses undefined', async () => {
  await assert.rejects(redis.set('u', undefined), TypeError);
});

test('ttl option expires keys; ttl() reports seconds, Infinity and null', async () => {
  await redis.set('short', 'x', { ttl: 0.2 });
  const left = await redis.ttl('short');
  assert.ok(left > 0 && left <= 0.2, `ttl was ${left}`);
  await redis.set('forever', 'x');
  assert.equal(await redis.ttl('forever'), Infinity);
  await sleep(300);
  assert.equal(await redis.get('short'), null);
  assert.equal(await redis.ttl('short'), null);
});

test('expire, has, del', async () => {
  await redis.set('a', 1);
  await redis.set('b', 2);
  assert.equal(await redis.has('a'), true);
  assert.equal(await redis.expire('a', 100), true);
  assert.equal(await redis.expire('nope', 100), false);
  assert.equal(await redis.del('a', 'b', 'nope'), 2);
  assert.equal(await redis.has('a'), false);
  assert.equal(await redis.del(), 0);
});

test('getMany / setMany', async () => {
  await redis.setMany({ m1: { x: 1 }, m2: 'two' }, { ttl: 60 });
  assert.deepEqual(await redis.getMany(['m1', 'm2', 'm3']), [{ x: 1 }, 'two', null]);
  assert.ok((await redis.ttl('m1')) > 59);
  assert.deepEqual(await redis.getMany([]), []);
});

test('incr counts and sets the TTL only once (fixed window)', async () => {
  assert.equal(await redis.incr('views'), 1);
  assert.equal(await redis.incr('views', { by: 5 }), 6);
  assert.equal(await redis.incr('win', { ttl: 10 }), 1);
  await redis.client.pexpire(`${redis.prefix}win`, 5000);
  assert.equal(await redis.incr('win', { ttl: 10 }), 2);
  const left = await redis.ttl('win');
  assert.ok(left <= 5, `TTL was reset to ${left}`);
});

test('namespaces isolate keys and keys() strips the prefix', async () => {
  const users = redis.namespace('users');
  const posts = redis.namespace('posts');
  await users.set('1', 'alice');
  await posts.set('1', 'hello');
  assert.equal(await users.get('1'), 'alice');
  assert.equal(await posts.get('1'), 'hello');
  assert.deepEqual(await users.keys(), ['1']);
  assert.equal(await redis.get('users:1'), 'alice');
});

test('clear() deletes only the namespace and refuses on the root', async () => {
  const temp = redis.namespace('temp');
  await temp.setMany({ a: 1, b: 2, c: 3 });
  await redis.set('keep', true);
  assert.equal(await temp.clear(), 3);
  assert.deepEqual(await temp.keys(), []);
  assert.equal(await redis.get('keep'), true);
  await assert.rejects(root.clear(), /namespace/);
});

test('connectRedis prefix option namespaces the root', async () => {
  const db = await connectRedis(server.url, { prefix: `app-${process.pid}`, logLevel: 'error' });
  await db.set('k', 'v');
  assert.equal(await db.client.get(`app-${process.pid}:k`), '"v"');
  await db.clear();
  await db.disconnect();
});

test('remember caches the result and runs fn once for concurrent callers', async () => {
  let calls = 0;
  const load = async () => { calls++; await sleep(50); return { report: 'big' }; };
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => redis.remember('report', 60, load)));
  results.forEach((result) => assert.deepEqual(result, { report: 'big' }));
  assert.equal(calls, 1);
  assert.deepEqual(await redis.remember('report', 60, load), { report: 'big' });
  assert.equal(calls, 1);
  assert.ok((await redis.ttl('report')) > 59);
});

test('remember caches null, skips undefined, and does not cache errors', async () => {
  assert.equal(await redis.remember('null', 60, async () => null), null);
  assert.equal(await redis.remember('null', 60, async () => 'changed'), null);
  assert.equal(await redis.remember('undef', 60, async () => undefined), undefined);
  assert.equal(await redis.has('undef'), false);
  await assert.rejects(redis.remember('boom', 60, async () => { throw new Error('db down'); }), /db down/);
  assert.equal(await redis.remember('boom', 60, async () => 'ok'), 'ok');
});

test('forget removes a remembered value', async () => {
  await redis.remember('f', 60, async () => 1);
  assert.equal(await redis.forget('f'), true);
  assert.equal(await redis.remember('f', 60, async () => 2), 2);
});

test('lock runs fn exclusively, returns its value, and releases', async () => {
  const order = [];
  const job = (name) => redis.lock('job', async () => {
    order.push(`${name}:start`);
    await sleep(50);
    order.push(`${name}:end`);
    return name;
  }, { wait: 2, retryDelay: 0.01 });
  const results = await Promise.all([job('a'), job('b')]);
  assert.deepEqual(results, ['a', 'b']);
  assert.ok(order.join() === 'a:start,a:end,b:start,b:end' || order.join() === 'b:start,b:end,a:start,a:end', order.join());
  assert.equal(await redis.has('lock:job'), false);
});

test('lock throws LockError when busy and wait is 0', async () => {
  const holding = redis.lock('busy', () => sleep(100));
  await sleep(10);
  await assert.rejects(redis.lock('busy', async () => 'never'), LockError);
  await holding;
});

test('lock releases when fn throws', async () => {
  await assert.rejects(redis.lock('fail', async () => { throw new Error('oops'); }), /oops/);
  assert.equal(await redis.has('lock:fail'), false);
});

test('lock does not delete a lock taken over by someone else after expiry', async () => {
  await redis.lock('expiring', async () => {
    await sleep(150);
    await redis.client.set(`${redis.prefix}lock:expiring`, 'other-owner');
  }, { ttl: 0.1 });
  assert.equal(await redis.client.get(`${redis.prefix}lock:expiring`), 'other-owner');
});

test('rateLimit allows up to limit per sliding window', async () => {
  const results = [];
  for (let i = 0; i < 4; i++) results.push(await redis.rateLimit('ip:1', { limit: 3, window: 0.3 }));
  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.deepEqual(results.map((r) => r.remaining), [2, 1, 0, 0]);
  assert.ok(results[3].resetIn > 0 && results[3].resetIn <= 0.3);
  await sleep(350);
  assert.equal((await redis.rateLimit('ip:1', { limit: 3, window: 0.3 })).allowed, true);
});

test('publish/subscribe delivers JSON messages and unsubscribe stops delivery', async () => {
  const received = [];
  const unsubscribe = await redis.subscribe('events', (message, channel) => received.push({ message, channel }));
  await redis.publish('events', { type: 'signup', id: 7 });
  await sleep(50);
  assert.deepEqual(received, [{ message: { type: 'signup', id: 7 }, channel: `${redis.prefix}events` }]);
  await unsubscribe();
  await redis.publish('events', { type: 'ignored' });
  await sleep(50);
  assert.equal(received.length, 1);
});

test('a throwing subscriber does not break other subscribers', async () => {
  const received = [];
  const offA = await redis.subscribe('multi', () => { throw new Error('bad handler'); });
  const offB = await redis.subscribe('multi', (message) => received.push(message));
  await redis.publish('multi', 'hi');
  await sleep(50);
  assert.deepEqual(received, ['hi']);
  await offA();
  await offB();
});
