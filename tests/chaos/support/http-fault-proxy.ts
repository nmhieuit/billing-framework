import {
  createServer,
  request as httpRequest,
  type ClientRequest,
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
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    // Client ngắt giữa chừng có thể chỉ phát 'close' (không 'end'/'error').
    req.on('close', () => {
      if (!req.complete) reject(new Error('client ngắt kết nối khi đang gửi body'));
    });
  });
}

function isValidDecision(decision: unknown): decision is ProxyDecision {
  if (decision === 'forward' || decision === 'drop' || decision === 'duplicate') return true;
  if (typeof decision !== 'object' || decision === null) return false;
  const d = decision as Record<string, unknown>;
  return typeof d.status === 'number' || typeof d.delayMs === 'number';
}

// Proxy HTTP tiêm lỗi: mỗi request gọi plan.hit(`${name}.request`) để rule đặt info.decision,
// rồi (nếu có chuyển tiếp) gọi plan.hit(`${name}.response`) TRƯỚC khi trả phản hồi cho client.
export class HttpFaultProxy {
  readonly log: ProxyLogEntry[] = [];
  readonly baseUrl: string;
  private readonly sockets = new Set<Socket>();
  // Timer chờ và request upstream đang bay: stop() phải dọn để không còn chuyển tiếp sau khi dừng.
  private readonly timers = new Set<{ timer: NodeJS.Timeout; reject: (e: Error) => void }>();
  private readonly upstreams = new Set<ClientRequest>();
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
    server.on('request', (req, res) => void proxy.handleSafely(req, res));
    return proxy;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const t of this.timers) {
      clearTimeout(t.timer);
      t.reject(new Error('proxy đã dừng'));
    }
    this.timers.clear();
    for (const upstream of this.upstreams) upstream.destroy();
    this.upstreams.clear();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
      for (const socket of this.sockets) socket.destroy();
    });
  }

  // Mọi lỗi (client ngắt giữa chừng, decision sai, chuyển tiếp hỏng) kết thúc có kiểm soát:
  // ghi log 'error', trả 500 nếu chưa gửi header, ngược lại đóng socket. Không để rejection lọt ra ngoài.
  private async handleSafely(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.handle(req, res);
    } catch {
      this.log.push({ method: req.method ?? 'GET', url: req.url ?? '/', decision: 'error' });
      try {
        if (!res.headersSent && !req.socket.destroyed) {
          res.writeHead(500);
          res.end();
        } else {
          req.socket.destroy();
        }
      } catch {
        req.socket.destroy();
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = {
        timer: setTimeout(() => {
          this.timers.delete(entry);
          resolve();
        }, ms),
        reject,
      };
      this.timers.add(entry);
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
    const decision = info.decision;
    if (!isValidDecision(decision)) {
      throw new Error(`decision không hợp lệ: ${JSON.stringify(decision)}`);
    }

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
      // writeHead ném RangeError nếu status không hợp lệ => handleSafely trả 500.
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
      await this.sleep(decision.delayMs);
    }
    let upstream: UpstreamResponse;
    try {
      upstream = await this.forward(req, raw);
    } catch {
      if (this.stopped) throw new Error('proxy đã dừng');
      // Mục tiêu không với tới được: client thấy 502.
      res.writeHead(502);
      res.end();
      this.log.push({ method, url, decision: label, status: 502 });
      return;
    }
    if (decision === 'duplicate') {
      label = 'duplicate';
      try {
        await this.forward(req, raw); // lần hai: bỏ phản hồi, client chỉ thấy lần đầu
      } catch {
        if (this.stopped) throw new Error('proxy đã dừng');
        label = 'duplicate-second-failed';
      }
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
    // Đặt lại content-length theo body đã gom; GET không body thì không thêm header.
    if (raw.length > 0 || req.headers['content-length'] !== undefined) {
      headers['content-length'] = raw.length;
    }
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
            // Giữ content-length của upstream (HEAD/204/304); chỉ bổ sung khi thiếu (chunked).
            if (outHeaders['content-length'] === undefined && body.length > 0) {
              outHeaders['content-length'] = body.length;
            }
            resolve({ status: response.statusCode ?? 502, headers: outHeaders, body });
          });
        },
      );
      this.upstreams.add(out);
      out.on('close', () => this.upstreams.delete(out));
      out.on('error', reject);
      out.end(raw);
    });
  }
}
