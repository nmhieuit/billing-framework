import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Máy chủ HTTP giả đóng vai wallet: ghi lại mọi webhook và trả mã trạng thái điều khiển được. */
export class WebhookReceiver {
  readonly received: ReceivedWebhook[] = [];
  readonly url: string;
  #queue: number[] = [];
  #defaultStatus = 200;
  #delayMs = 0;
  #server: Server;

  private constructor(server: Server, url: string) {
    this.#server = server;
    this.url = url;
  }

  static async start(): Promise<WebhookReceiver> {
    // Gán sau khi server lắng nghe (cần port), nhưng handler phải tham chiếu được từ trước.
    // eslint-disable-next-line prefer-const
    let receiver: WebhookReceiver | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receiver?.received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const status = receiver?.nextStatus() ?? 200;
        const delay = receiver?.delay() ?? 0;
        setTimeout(() => res.writeHead(status).end(), delay);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    receiver = new WebhookReceiver(server, `http://127.0.0.1:${port}/webhooks`);
    return receiver;
  }

  respondWith(...statuses: number[]): this {
    this.#queue.push(...statuses);
    return this;
  }

  setDefaultStatus(status: number): this {
    this.#defaultStatus = status;
    return this;
  }

  setDelay(ms: number): this {
    this.#delayMs = ms;
    return this;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  private nextStatus(): number {
    return this.#queue.shift() ?? this.#defaultStatus;
  }

  private delay(): number {
    return this.#delayMs;
  }
}
