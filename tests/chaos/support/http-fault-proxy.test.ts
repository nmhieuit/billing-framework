import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FaultPlan } from './fault-plan.js';
import { HttpFaultProxy } from './http-fault-proxy.js';
import { OpLog } from './op-log.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

// Server mục tiêu thật: ghi lại mọi request nhận được.
async function startTarget(): Promise<{ url: string; received: Received[]; server: Server }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      res.writeHead(201, { 'content-type': 'application/json', 'x-target': `n${received.length}` });
      res.end(JSON.stringify({ n: received.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, server };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(): Promise<{ plan: FaultPlan; proxy: HttpFaultProxy; received: Received[] }> {
  const target = await startTarget();
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        target.server.closeAllConnections();
        target.server.close(() => resolve());
      }),
  );
  const plan = new FaultPlan({ log: new OpLog() });
  const proxy = await HttpFaultProxy.start({ target: target.url, plan, name: 'payment' });
  cleanups.push(() => proxy.stop());
  return { plan, proxy, received: target.received };
}

const PATH = '/v1/charge?x=1&y=%20z';
const body = JSON.stringify({ note: 'Thanh toán đơn #1 — ¥100 "x" \\ \n 😀', amount: 12 });
const post = (base: string, path = PATH): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature': 'sha256=ab12CD+/=',
      'idempotency-key': 'idem-123',
    },
    body,
  });

describe('HttpFaultProxy', () => {
  it('forward giữ nguyên method, URL, header và body byte-for-byte', async () => {
    const { proxy, received } = await setup();
    const res = await post(proxy.baseUrl);
    expect(res.status).toBe(201);
    expect(res.headers.get('x-target')).toBe('n1');
    expect(await res.json()).toEqual({ n: 1 });
    expect(received).toHaveLength(1);
    const r = received[0] as Received;
    expect(r.method).toBe('POST');
    expect(r.url).toBe(PATH);
    expect(r.headers['x-signature']).toBe('sha256=ab12CD+/=');
    expect(r.headers['idempotency-key']).toBe('idem-123');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.body.equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(proxy.log).toEqual([{ method: 'POST', url: PATH, decision: 'forward', status: 201 }]);
  });

  it('forward giữ nguyên body nhị phân không phải UTF-8', async () => {
    const { proxy, received } = await setup();
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x0a]);
    await fetch(`${proxy.baseUrl}/bin`, { method: 'PUT', body: bytes });
    expect((received[0] as Received).body.equals(bytes)).toBe(true);
    expect((received[0] as Received).method).toBe('PUT');
  });

  it('drop: client nhận lỗi socket và mục tiêu không nhận request nào', async () => {
    const { plan, proxy, received } = await setup();
    plan.add({ point: 'payment.request', action: (i) => void (i.decision = 'drop') });
    await expect(post(proxy.baseUrl)).rejects.toThrow();
    expect(received).toHaveLength(0);
    expect(proxy.log).toEqual([{ method: 'POST', url: PATH, decision: 'drop' }]);
  });

  it('duplicate: mục tiêu nhận đúng 2 request giống hệt, client nhận phản hồi của lần đầu', async () => {
    const { plan, proxy, received } = await setup();
    plan.add({ point: 'payment.request', action: (i) => void (i.decision = 'duplicate') });
    const res = await post(proxy.baseUrl);
    expect(res.headers.get('x-target')).toBe('n1');
    expect(await res.json()).toEqual({ n: 1 });
    expect(received).toHaveLength(2);
    const [a, b] = received as [Received, Received];
    expect(b.method).toBe(a.method);
    expect(b.url).toBe(a.url);
    expect(b.body.equals(a.body)).toBe(true);
    expect(b.headers['x-signature']).toBe(a.headers['x-signature']);
    expect(b.headers['idempotency-key']).toBe(a.headers['idempotency-key']);
    expect(a.body.equals(Buffer.from(body, 'utf8'))).toBe(true);
    expect(proxy.log).toEqual([{ method: 'POST', url: PATH, decision: 'duplicate', status: 201 }]);
  });

  it('{ status: 503 }: trả 503 và mục tiêu không nhận gì', async () => {
    const { plan, proxy, received } = await setup();
    plan.add({
      point: 'payment.request',
      action: (i) => void (i.decision = { status: 503, body: { error: 'unavailable' } }),
    });
    const res = await post(proxy.baseUrl);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'unavailable' });
    expect(received).toHaveLength(0);
    expect(proxy.log).toEqual([{ method: 'POST', url: PATH, decision: 'status', status: 503 }]);
  });

  it('{ delayMs }: chờ đúng khoảng rồi mới chuyển tiếp', async () => {
    const { plan, proxy, received } = await setup();
    plan.add({ point: 'payment.request', action: (i) => void (i.decision = { delayMs: 400 }) });
    const started = Date.now();
    const pending = post(proxy.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toHaveLength(0); // chưa chuyển tiếp trong lúc chờ
    const res = await pending;
    const elapsed = Date.now() - started;
    expect(res.status).toBe(201);
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(3000);
    expect(received).toHaveLength(1);
    expect(proxy.log[0]?.decision).toBe('delay');
  });

  it('info của request chứa name, method, url, body; plan.hit đúng điểm', async () => {
    const { plan, proxy } = await setup();
    const seen: Array<Record<string, unknown>> = [];
    plan.add({ point: 'payment.request', action: (i) => void seen.push({ ...i }) });
    await post(proxy.baseUrl);
    expect(seen).toEqual([
      { name: 'payment', method: 'POST', url: PATH, body, decision: 'forward' },
    ]);
    expect(plan.hits('payment.request')).toBe(1);
  });

  describe('điểm .response', () => {
    it('hit sau khi nhận phản hồi của mục tiêu, info có status; forward bình thường', async () => {
      const { plan, proxy, received } = await setup();
      const seen: Array<Record<string, unknown>> = [];
      plan.add({
        point: 'payment.response',
        action: (i) => void seen.push({ ...i, targetSeen: received.length }),
      });
      const res = await post(proxy.baseUrl);
      expect(res.status).toBe(201);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        name: 'payment',
        method: 'POST',
        status: 201,
        targetSeen: 1,
      });
    });

    it('action ném: mục tiêu ĐÃ xử lý nhưng client không nhận được phản hồi', async () => {
      const { plan, proxy, received } = await setup();
      plan.add({
        point: 'payment.response',
        action: () => {
          throw new Error('mất phản hồi');
        },
      });
      await expect(post(proxy.baseUrl)).rejects.toThrow();
      expect(received).toHaveLength(1);
      expect(proxy.log).toEqual([
        { method: 'POST', url: PATH, decision: 'drop-response', status: 201 },
      ]);
    });

    it('rule .response chỉ bắn một lần: lần sau client nhận phản hồi bình thường', async () => {
      const { plan, proxy, received } = await setup();
      plan.add({
        point: 'payment.response',
        times: 1,
        action: () => {
          throw new Error('mất phản hồi');
        },
      });
      await expect(post(proxy.baseUrl)).rejects.toThrow();
      const retry = await post(proxy.baseUrl);
      expect(retry.status).toBe(201);
      expect(received).toHaveLength(2);
    });

    it('request bị trả status giả thì KHÔNG có điểm .response', async () => {
      const { plan, proxy } = await setup();
      plan.add({ point: 'payment.request', action: (i) => void (i.decision = { status: 500 }) });
      await post(proxy.baseUrl);
      expect(plan.hits('payment.response')).toBe(0);
    });
  });

  it('stop đóng sạch, không treo, và cổng không còn nhận kết nối', async () => {
    const { proxy } = await setup();
    await post(proxy.baseUrl); // tạo kết nối rồi mới dừng
    await proxy.stop();
    await expect(fetch(`${proxy.baseUrl}/x`)).rejects.toThrow();
    await proxy.stop(); // gọi lần hai vẫn an toàn
  });

  it('nhật ký ghi đủ thứ tự nhiều request', async () => {
    const { plan, proxy } = await setup();
    plan.add({
      point: 'payment.request',
      nth: 2,
      action: (i) => void (i.decision = { status: 429 }),
    });
    await post(proxy.baseUrl, '/a');
    await post(proxy.baseUrl, '/b');
    await post(proxy.baseUrl, '/c');
    expect(proxy.log.map((l) => [l.url, l.decision, l.status])).toEqual([
      ['/a', 'forward', 201],
      ['/b', 'status', 429],
      ['/c', 'forward', 201],
    ]);
  });
});
