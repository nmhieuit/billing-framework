import type { ConfirmChannel } from 'amqplib';
import type { OutgoingMessage, PublishResult } from './types.js';

const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Publish có confirm và `mandatory`. Broker vẫn confirm message không định tuyến được (và bỏ lặng lẽ nếu không
 * `mandatory`), nên ta lắng nghe `return` — gửi TRƯỚC confirm — để biết message không có nơi nhận.
 * Không bao giờ ném.
 */
export class ConfirmPublisher {
  readonly #returned = new Set<string>();
  #channel: ConfirmChannel | undefined;

  attach(channel: ConfirmChannel): void {
    this.#channel = channel;
    channel.on('return', (message) => {
      const id = message.properties.messageId;
      if (typeof id === 'string') this.#returned.add(id);
    });
  }

  detach(channel: ConfirmChannel): void {
    if (this.#channel === channel) this.#channel = undefined;
  }

  detachAll(): void {
    this.#channel = undefined;
  }

  publish(message: OutgoingMessage, headers: Record<string, unknown> = {}): Promise<PublishResult> {
    const channel = this.#channel;
    if (!channel) return Promise.resolve({ kind: 'failed', error: 'broker is not connected' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: PublishResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#returned.delete(message.messageId);
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ kind: 'failed', error: `no confirm within ${PUBLISH_TIMEOUT_MS} ms` }),
        PUBLISH_TIMEOUT_MS,
      );
      try {
        channel.publish(
          message.exchange,
          message.routingKey,
          Buffer.from(message.body, 'utf8'),
          {
            mandatory: true,
            persistent: true,
            contentType: 'application/json',
            messageId: message.messageId,
            type: message.type,
            headers: { ...headers, 'x-correlation-id': message.correlationId },
          },
          (error) => {
            if (error) {
              finish({
                kind: 'failed',
                error: error instanceof Error ? error.message : String(error),
              });
            } else {
              finish(
                this.#returned.has(message.messageId)
                  ? { kind: 'unroutable' }
                  : { kind: 'delivered' },
              );
            }
          },
        );
      } catch (error) {
        finish({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
