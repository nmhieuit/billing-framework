import { createHash, randomBytes } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FaultPlan } from './fault-plan.js';
import { HttpFaultProxy } from './http-fault-proxy.js';
import { OpLog } from './op-log.js';

type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer, n: number) => void;

// Target thật với handler tuỳ biến; `hits` đếm số request đã tới (kể cả khi handler đóng socket).
async function startTarget(
  handler: Handler,
): Promise<{ url: string; hits: () => number; bodies: Buffer[]; server: Server }> {
  let hits = 0;
  const bodies: Buffer[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hits += 1;
      const body = Buffer.concat(chunks);
      bodies.push(body);
      handler(req, res, body, hits);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits: () => hits,
    bodies,
    server,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

async function setup(handler: Handler): Promise<{
  plan: FaultPlan;
  proxy: HttpFaultProxy;
  target: Awaited<ReturnType<typeof startTarget>>;
}> {
  const target = await startTarget(handler);
  cleanups.push(() => closeServer(target.server));
  const plan = new FaultPlan({ log: new OpLog() });
  const proxy = await HttpFaultProxy.start({ target: target.url, plan, name: 'p' });
  cleanups.push(() => proxy.stop());
  return { plan, proxy, target };
}

const ok: Handler = (_req, res, body) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`len=${body.length}`);
};

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond() && Date.now() < end) await pause(20);
  if (!cond()) throw new Error('waitFor: hết thời gian');
}

describe('HttpFaultProxy độ bền', () => {
  it('client ngắt giữa chừng khi gửi body: không unhandled rejection, mục tiêu không nhận gì, proxy vẫn sống', async () => {
    const { proxy, target } = await setup(ok);
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): number => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const port = Number(new URL(proxy.baseUrl).port);
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/abort',
        headers: { 'content-length': 1000 },
      });
      req.on('error', () => undefined);
      req.write(Buffer.alloc(100)); // mới gửi 100/1000 byte
      await pause(100);
      req.destroy();
      await waitFor(() => proxy.log.length > 0); // chờ proxy xử lý xong việc client ngắt
      expect(rejections).toEqual([]);
      expect(target.hits()).toBe(0);
      expect(proxy.log.map((l) => l.decision)).toEqual(['error']);
      expect((await fetch(`${proxy.baseUrl}/after`)).status).toBe(200);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('decision có status không hợp lệ: trả 500, log error, proxy vẫn phục vụ request sau', async () => {
    const { plan, proxy, target } = await setup(ok);
    plan.add({
      point: 'p.request',
      times: 1,
      action: (i) => void (i.decision = { status: 99 }),
    });
    expect((await fetch(`${proxy.baseUrl}/bad`)).status).toBe(500);
    expect(proxy.log.map((l) => l.decision)).toEqual(['error']);
    expect(target.hits()).toBe(0);
    expect((await fetch(`${proxy.baseUrl}/good`)).status).toBe(200);
  });

  it('decision lạ bị coi là lỗi (500), không âm thầm forward', async () => {
    const { plan, proxy, target } = await setup(ok);
    plan.add({ point: 'p.request', action: (i) => void (i.decision = 'duplicat') });
    expect((await fetch(`${proxy.baseUrl}/x`)).status).toBe(500);
    expect(target.hits()).toBe(0);
    expect(proxy.log.map((l) => l.decision)).toEqual(['error']);
  });

  it('mục tiêu không với tới được: 502 và log', async () => {
    const { proxy, target } = await setup(ok);
    await closeServer(target.server); // cổng đóng thật
    const res = await fetch(`${proxy.baseUrl}/x`);
    expect(res.status).toBe(502);
    expect(proxy.log).toEqual([{ method: 'GET', url: '/x', decision: 'forward', status: 502 }]);
  });

  it('duplicate mà lần hai hỏng: vẫn trả phản hồi lần đầu và ghi log', async () => {
    const { plan, proxy, target } = await setup((req, res, body, n) => {
      if (n === 2)
        req.socket.destroy(); // lần hai: mục tiêu đóng socket
      else {
        res.writeHead(200);
        res.end(`first len=${body.length}`);
      }
    });
    plan.add({ point: 'p.request', action: (i) => void (i.decision = 'duplicate') });
    const res = await fetch(`${proxy.baseUrl}/d`, { method: 'POST', body: 'abc' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('first len=3');
    expect(target.hits()).toBe(2);
    expect(proxy.log).toEqual([
      { method: 'POST', url: '/d', decision: 'duplicate-second-failed', status: 200 },
    ]);
    expect(proxy.duplicateStatuses).toEqual([]); // lần hai hỏng nên không có mã trạng thái
  });

  it('HEAD giữ content-length của upstream và không có body', async () => {
    const { proxy } = await setup((req, res) => {
      res.writeHead(200, { 'content-length': 42, 'content-type': 'text/plain' });
      res.end(req.method === 'HEAD' ? undefined : 'x'.repeat(42));
    });
    const head = await fetch(`${proxy.baseUrl}/h`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('42');
    expect(await head.text()).toBe('');
    expect((await fetch(`${proxy.baseUrl}/h`)).headers.get('content-length')).toBe('42');
  });

  it('204 không bị thêm body/content-length', async () => {
    const { proxy } = await setup((_req, res) => {
      res.writeHead(204);
      res.end();
    });
    const res = await fetch(`${proxy.baseUrl}/n`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('stop() huỷ request đang chờ delay: mục tiêu không nhận gì sau khi dừng', async () => {
    const { plan, proxy, target } = await setup(ok);
    plan.add({ point: 'p.request', action: (i) => void (i.decision = { delayMs: 300 }) });
    const pending = fetch(`${proxy.baseUrl}/late`).catch((e: unknown) => e);
    await pause(100);
    await proxy.stop();
    const outcome = await pending;
    await pause(500);
    expect(target.hits()).toBe(0);
    expect(outcome instanceof Error || (outcome as Response).status >= 500).toBe(true);
  });

  it('10 request đồng thời đều tới đúng đích, đúng phản hồi', async () => {
    const { proxy, target } = await setup(ok);
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_v, i) => {
        const res = await fetch(`${proxy.baseUrl}/c${i}`, {
          method: 'POST',
          body: 'z'.repeat(i + 1),
        });
        return [res.status, await res.text()] as const;
      }),
    );
    expect(results.map((r) => r[1]).sort()).toEqual(
      Array.from({ length: 10 }, (_v, i) => `len=${i + 1}`).sort(),
    );
    expect(results.every((r) => r[0] === 200)).toBe(true);
    expect(target.hits()).toBe(10);
    expect(proxy.log).toHaveLength(10);
  });

  it('body ~1MB đi qua nguyên vẹn (so hash), cả request lẫn response', async () => {
    const big = randomBytes(1024 * 1024);
    const { proxy, target } = await setup((_req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(body); // echo
    });
    const res = await fetch(`${proxy.baseUrl}/big`, { method: 'POST', body: big });
    const echoed = Buffer.from(await res.arrayBuffer());
    expect(sha(target.bodies[0] as Buffer)).toBe(sha(big));
    expect(sha(echoed)).toBe(sha(big));
  });
});
