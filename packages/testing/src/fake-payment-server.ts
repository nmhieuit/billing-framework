import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePaymentRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakePaymentResponse {
  status: number;
  body?: unknown;
  delayMs?: number;
}

const defaultResponse = (requestNumber: number): FakePaymentResponse => ({
  status: 202,
  body: { chargeId: `ch_fake_${requestNumber}`, status: 'PENDING' },
});

/** Máy chủ HTTP giả đóng vai payment: ghi lại request và trả phản hồi theo kịch bản. */
export class FakePaymentServer {
  readonly requests: FakePaymentRequest[] = [];
  readonly baseUrl: string;
  #queue: FakePaymentResponse[] = [];
  #fallback: (requestNumber: number, request: FakePaymentRequest) => FakePaymentResponse =
    defaultResponse;
  #server: Server;

  private constructor(server: Server, baseUrl: string) {
    this.#server = server;
    this.baseUrl = baseUrl;
  }

  static async start(): Promise<FakePaymentServer> {
    // eslint-disable-next-line prefer-const -- gán sau khi server đã lắng nghe vì handler cần tham chiếu đến `fake`
    let fake: FakePaymentServer | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const request: FakePaymentRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        fake?.requests.push(request);
        const response = fake?.nextResponse(request) ?? defaultResponse(0);
        setTimeout(() => {
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(response.body === undefined ? '' : JSON.stringify(response.body));
        }, response.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    fake = new FakePaymentServer(server, `http://127.0.0.1:${port}`);
    return fake;
  }

  enqueue(...responses: FakePaymentResponse[]): this {
    this.#queue.push(...responses);
    return this;
  }

  setFallback(
    fallback: (requestNumber: number, request: FakePaymentRequest) => FakePaymentResponse,
  ): this {
    this.#fallback = fallback;
    return this;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  private nextResponse(request: FakePaymentRequest): FakePaymentResponse {
    return this.#queue.shift() ?? this.#fallback(this.requests.length, request);
  }
}
