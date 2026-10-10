import { randomUUID } from 'node:crypto';
import type { ConfirmChannel } from 'amqplib';
import type { OutgoingMessage, PublishResult } from './types.js';

const PUBLISH_TIMEOUT_MS = 10_000;

/** Header định danh từng lần publish để ghép `return` đúng với lần publish đó (không dựa vào messageId). */
export const PUBLISH_ID_HEADER = 'x-publish-id';

/**
 * Publish có confirm và `mandatory`. Broker vẫn confirm message không định tuyến được (và bỏ lặng lẽ nếu không
 * `mandatory`), nên ta lắng nghe `return` — gửi TRƯỚC confirm — để biết message không có nơi nhận.
 * Không bao giờ ném.
 */
export class ConfirmPublisher {
  /** Mỗi lần publish đang chờ confirm, theo token riêng; `return` muộn của lần đã settle bị bỏ qua. */
  readonly #pending = new Map<string, { returned: boolean }>();
  readonly #timeoutMs: number;
  #channel: ConfirmChannel | undefined;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;
  }

  attach(channel: ConfirmChannel): void {
    this.#channel = channel;
    channel.on('return', (message) => {
      const token: unknown = message.properties.headers?.[PUBLISH_ID_HEADER];
      if (typeof token === 'string') {
        const entry = this.#pending.get(token);
        if (entry) entry.returned = true;
      }
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
    const token = randomUUID();
    const entry = { returned: false };
    this.#pending.set(token, entry);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: PublishResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#pending.delete(token);
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ kind: 'failed', error: `no confirm within ${this.#timeoutMs} ms` }),
        this.#timeoutMs,
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
            // Token luôn ghi đè: giá trị do bên gọi truyền vào không được phép trùng.
            headers: {
              ...headers,
              'x-correlation-id': message.correlationId,
              [PUBLISH_ID_HEADER]: token,
            },
          },
          (error) => {
            if (error) {
              finish({
                kind: 'failed',
                error: error instanceof Error ? error.message : String(error),
              });
            } else {
              finish(entry.returned ? { kind: 'unroutable' } : { kind: 'delivered' });
            }
          },
        );
      } catch (error) {
        finish({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
