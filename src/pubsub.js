import { serialize, deserialize } from './serialize.js';

// One lazily-created subscriber connection shared by every namespace.
export class PubSub {
  #client = null;
  #logger = null;
  #subscriber = null;
  #handlers = new Map();

  constructor(client, logger) {
    this.#client = client;
    this.#logger = logger;
  }

  async publish(channel, message) {
    return this.#client.publish(channel, serialize(message));
  }

  async subscribe(channel, handler) {
    const handlers = this.#handlersFor(channel);
    handlers.add(handler);
    if (handlers.size === 1) await this.#getSubscriber().subscribe(channel);
    this.#logger.debug(`Subscribed to ${channel}`);
    return () => this.#unsubscribe(channel, handler);
  }

  async close() {
    if (this.#subscriber) await this.#subscriber.quit();
    this.#subscriber = null;
    this.#handlers.clear();
  }

  async #unsubscribe(channel, handler) {
    const handlers = this.#handlers.get(channel);
    if (!handlers?.delete(handler) || handlers.size > 0) return;
    this.#handlers.delete(channel);
    await this.#subscriber?.unsubscribe(channel);
  }

  #handlersFor(channel) {
    if (!this.#handlers.has(channel)) this.#handlers.set(channel, new Set());
    return this.#handlers.get(channel);
  }

  #getSubscriber() {
    if (this.#subscriber) return this.#subscriber;
    this.#subscriber = this.#client.duplicate();
    this.#subscriber.on('error', (error) => this.#logger.error(`Subscriber error: ${error.message}`));
    this.#subscriber.on('message', (channel, raw) => this.#dispatch(channel, raw));
    return this.#subscriber;
  }

  #dispatch(channel, raw) {
    const message = deserialize(raw);
    for (const handler of this.#handlers.get(channel) ?? []) {
      Promise.resolve()
        .then(() => handler(message, channel))
        .catch((error) => this.#logger.error(`Handler for ${channel} failed: ${error.message}`));
    }
  }
}
