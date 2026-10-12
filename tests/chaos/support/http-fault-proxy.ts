import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { FaultPlan } from './fault-plan.js';

export type ProxyDecision =
  'forward' | 'drop' | 'duplicate' | { status: number; body?: unknown } | { delayMs: number };

export interface ProxyLogEntry {
  method: string;
  url: string;
  decision: string;
  status?: number;
}

interface UpstreamResponse {
  status: number;
  headers: OutgoingHttpHeaders;
  body: Buffer;
}

// Header hop-by-hop không được chuyển tiếp nguyên văn.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host']);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Proxy HTTP tiêm lỗi: mỗi request gọi plan.hit(`${name}.request`) để rule đặt info.decision,
// rồi (nếu có chuyển tiếp) gọi plan.hit(`${name}.response`) TRƯỚC khi trả phản hồi cho client.
export class HttpFaultProxy {
  readonly log: ProxyLogEntry[] = [];
  readonly baseUrl: string;
  private readonly sockets = new Set<Socket>();
  private stopped = false;

  private constructor(
    private readonly server: Server,
    private readonly target: URL,
    private readonly plan: FaultPlan,
    private readonly name: string,
    port: number,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    server.on('connection', (socket: Socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(options: {
    target: string;
    plan: FaultPlan;
    name: string;
  }): Promise<HttpFaultProxy> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const proxy = new HttpFaultProxy(
      server,
      new URL(options.target),
      options.plan,
      options.name,
      port,
    );
    server.on('request', (req, res) => void proxy.handle(req, res));
    return proxy;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const raw = await readBody(req);
    const info: Record<string, unknown> = {
      name: this.name,
      method,
      url,
      body: raw.toString('utf8'),
      decision: 'forward',
    };
    try {
      await this.plan.hit(`${this.name}.request`, info);
    } catch {
      // Action ném ở điểm request: coi như rớt kết nối.
      info.decision = 'drop';
    }
    const decision = info.decision as ProxyDecision;

    if (decision === 'drop') {
      this.log.push({ method, url, decision: 'drop' });
      req.socket.destroy();
      return;
    }
    if (typeof decision === 'object' && 'status' in decision) {
      const payload =
        decision.body === undefined
          ? Buffer.alloc(0)
          : Buffer.from(
              typeof decision.body === 'string' ? decision.body : JSON.stringify(decision.body),
            );
      res.writeHead(decision.status, {
        'content-type': typeof decision.body === 'string' ? 'text/plain' : 'application/json',
        'content-length': payload.length,
      });
      res.end(payload);
      this.log.push({ method, url, decision: 'status', status: decision.status });
      return;
    }

    let label = 'forward';
    if (typeof decision === 'object' && 'delayMs' in decision) {
      label = 'delay';
      await new Promise((resolve) => setTimeout(resolve, decision.delayMs));
    }
    let upstream: UpstreamResponse;
    try {
      upstream = await this.forward(req, raw);
      if (decision === 'duplicate') {
        label = 'duplicate';
        await this.forward(req, raw); // lần hai: bỏ phản hồi, client chỉ thấy lần đầu
      }
    } catch {
      // Mục tiêu không với tới được: client thấy 502.
      res.writeHead(502);
      res.end();
      this.log.push({ method, url, decision: label, status: 502 });
      return;
    }

    try {
      await this.plan.hit(`${this.name}.response`, {
        name: this.name,
        method,
        url,
        status: upstream.status,
      });
    } catch {
      // Action ném ở điểm response: mục tiêu đã xử lý nhưng client không bao giờ thấy phản hồi.
      this.log.push({ method, url, decision: 'drop-response', status: upstream.status });
      req.socket.destroy();
      return;
    }
    res.writeHead(upstream.status, upstream.headers);
    res.end(upstream.body);
    this.log.push({ method, url, decision: label, status: upstream.status });
  }

  // Chuyển tiếp nguyên method/URL/header/body (dạng byte) tới mục tiêu và gom phản hồi.
  private forward(req: IncomingMessage, raw: Buffer): Promise<UpstreamResponse> {
    const headers: OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key)) headers[key] = value;
    }
    headers['content-length'] = raw.length;
    return new Promise((resolve, reject) => {
      const out = httpRequest(
        {
          hostname: this.target.hostname,
          port: this.target.port,
          method: req.method,
          path: req.url,
          headers,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            const outHeaders: OutgoingHttpHeaders = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (!HOP_BY_HOP.has(key)) outHeaders[key] = value;
            }
            const body = Buffer.concat(chunks);
            outHeaders['content-length'] = body.length;
            resolve({ status: response.statusCode ?? 502, headers: outHeaders, body });
          });
        },
      );
      out.on('error', reject);
      out.end(raw);
    });
  }
}
