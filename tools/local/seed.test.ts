import { validateEvent } from '@billing/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildAmqpUrl,
  declareSinkQueue,
  SINK_QUEUE,
  parseEnvFile,
  resolveMqPassword,
  seed,
  SeedError,
  type PublishedMessage,
  type SeedDeps,
  type SeedOptions,
} from './seed.js';

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Wallet giả: nạp tiền thành SUCCEEDED ngay (hoặc không bao giờ), đối soát COMPLETED sau `runPolls` lần hỏi. */
function fakeWallet(options: { topupStatus?: string; runPolls?: number; runStatus?: string } = {}) {
  const calls: Call[] = [];
  const topups = new Map<string, string>();
  let runPolls = 0;
  const fetchImpl: SeedDeps['fetchImpl'] = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    calls.push({ method, path: url.pathname, headers, body });
    if (method === 'POST' && url.pathname === '/wallets') return json(201, { balance: 0 });
    if (method === 'POST' && url.pathname === '/topups') {
      const key = headers['Idempotency-Key']!;
      if (!topups.has(key)) topups.set(key, `topup-${topups.size + 1}`);
      return json(202, { topupId: topups.get(key), status: 'REQUESTED' });
    }
    const t = /^\/topups\/(.+)$/.exec(url.pathname);
    if (method === 'GET' && t)
      return json(200, { topupId: t[1], status: options.topupStatus ?? 'SUCCEEDED' });
    if (method === 'POST' && url.pathname === '/reconciliations')
      return json(202, { runId: 'run-1', status: 'RUNNING' });
    if (method === 'GET' && url.pathname === '/reconciliations/run-1') {
      runPolls += 1;
      const done = runPolls > (options.runPolls ?? 0);
      return json(200, {
        runId: 'run-1',
        status: done ? (options.runStatus ?? 'COMPLETED') : 'RUNNING',
      });
    }
    return json(404, { message: `unhandled ${method} ${url.pathname}` });
  };
  return { fetchImpl, calls };
}

const setup = (wallet = fakeWallet(), over: Partial<SeedOptions> = {}) => {
  const published: PublishedMessage[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  let clock = 0;
  const deps: SeedDeps = {
    fetchImpl: async (input, init) => {
      const url = new URL(input);
      order.push(`${init?.method ?? 'GET'} ${url.pathname.split('/').slice(0, 2).join('/')}`);
      return wallet.fetchImpl(input, init);
    },
    declareSink: async () => {
      order.push('declareSink');
    },
    publish: async (m) => {
      order.push('publish');
      published.push(m);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    log: (m) => void logs.push(m),
  };
  const options: SeedOptions = {
    walletUrl: 'http://wallet',
    tenants: ['acme', 'beta'],
    withDlq: false,
    reconcileDate: '2026-10-11',
    timeoutMs: 90_000,
    pollMs: 1000,
    ...over,
  };
  return { deps, options, published, logs, order, wallet };
};

const topupKeys = (calls: Call[]) =>
  calls
    .filter((c) => c.path === '/topups' && c.method === 'POST')
    .map((c) => c.headers['Idempotency-Key']);

describe('sink queue', () => {
  it('declares a durable queue and binds it to billing.events with # (idempotent)', async () => {
    const calls: unknown[][] = [];
    const channel = {
      assertQueue: async (...a: unknown[]) => void calls.push(['assertQueue', ...a]),
      bindQueue: async (...a: unknown[]) => void calls.push(['bindQueue', ...a]),
    };
    await declareSinkQueue(channel);
    expect(calls).toEqual([
      ['assertQueue', 'ecommerce.billing-events', { durable: true }],
      ['bindQueue', 'ecommerce.billing-events', 'billing.events', '#'],
    ]);
    // Chạy lại cho đúng cùng khai báo (AMQP assert/bind là idempotent).
    await declareSinkQueue(channel);
    expect(calls.slice(2)).toEqual(calls.slice(0, 2));
    expect(SINK_QUEUE).toBe('ecommerce.billing-events');
  });

  it('seed declares the sink exactly once, before any wallet call or publish', async () => {
    const s = setup();
    await seed(s.options, s.deps);
    expect(s.order.filter((o) => o === 'declareSink')).toHaveLength(1);
    expect(s.order[0]).toBe('declareSink');
  });
});

describe('seed', () => {
  it('runs wallets, top-ups, orders, reconciliation in that order', async () => {
    const s = setup();
    await seed(s.options, s.deps);
    const first = (needle: string) => s.order.indexOf(needle);
    const last = (needle: string) => s.order.lastIndexOf(needle);
    expect(last('POST /wallets')).toBeLessThan(first('POST /topups'));
    expect(last('POST /topups')).toBeLessThan(first('publish'));
    expect(last('publish')).toBeLessThan(first('POST /reconciliations'));
    expect(s.logs.length).toBeGreaterThanOrEqual(4);
  });

  it('creates 3 wallets per tenant with the gateway headers', async () => {
    const s = setup();
    await seed(s.options, s.deps);
    const creates = s.wallet.calls.filter((c) => c.method === 'POST' && c.path === '/wallets');
    expect(creates).toHaveLength(6);
    expect(creates.map((c) => `${c.headers['x-tenant-id']}/${c.headers['x-customer-id']}`)).toEqual(
      ['acme/seed-1', 'acme/seed-2', 'acme/seed-3', 'beta/seed-1', 'beta/seed-2', 'beta/seed-3'],
    );
    expect(creates.every((c) => (c.body as { currency: string }).currency === 'VND')).toBe(true);
  });

  it('tops up 500000 with a deterministic idempotency key (same on re-run)', async () => {
    const first = setup();
    await seed(first.options, first.deps);
    const second = setup();
    await seed(second.options, second.deps);
    expect(topupKeys(first.wallet.calls)).toEqual(topupKeys(second.wallet.calls));
    expect(new Set(topupKeys(first.wallet.calls)).size).toBe(6);
    const topups = first.wallet.calls.filter((c) => c.path === '/topups' && c.method === 'POST');
    expect(topups.every((c) => (c.body as { amount: number }).amount === 500000)).toBe(true);
  });

  it('publishes 3 valid OrderReadyForPaymentV1 per tenant, one over the balance', async () => {
    const s = setup();
    await seed(s.options, s.deps);
    expect(s.published).toHaveLength(6);
    for (const m of s.published) {
      expect(m.routingKey).toBe('order-ready-for-payment.v1');
      expect(m.type).toBe('OrderReadyForPaymentV1');
      const body = JSON.parse(m.body) as { eventId: string };
      expect(m.messageId).toBe(body.eventId);
      expect(validateEvent('OrderReadyForPaymentV1', body).ok).toBe(true);
    }
    const bodies = s.published.map(
      (m) => JSON.parse(m.body) as { tenantId: string; amount: number },
    );
    for (const tenant of ['acme', 'beta']) {
      const amounts = bodies.filter((b) => b.tenantId === tenant).map((b) => b.amount);
      expect(amounts.filter((a) => a <= 500000)).toHaveLength(2);
      expect(amounts.filter((a) => a === 10_000_000)).toHaveLength(1);
    }
  });

  it('uses fresh event ids on every run', async () => {
    const a = setup();
    await seed(a.options, a.deps);
    const b = setup();
    await seed(b.options, b.deps);
    expect(new Set([...a.published, ...b.published].map((m) => m.messageId)).size).toBe(12);
  });

  it('requests reconciliation for today with the tenant header and polls to COMPLETED', async () => {
    const s = setup(fakeWallet({ runPolls: 2 }));
    await seed(s.options, s.deps);
    const posts = s.wallet.calls.filter(
      (c) => c.method === 'POST' && c.path === '/reconciliations',
    );
    expect(posts.map((c) => c.headers['x-tenant-id'])).toEqual(['acme', 'beta']);
    expect(posts.every((c) => (c.body as { date: string }).date === '2026-10-11')).toBe(true);
    expect(
      s.wallet.calls.filter((c) => c.path === '/reconciliations/run-1').length,
    ).toBeGreaterThan(2);
  });

  it('fails clearly when a reconciliation run ends FAILED', async () => {
    const s = setup(fakeWallet({ runStatus: 'FAILED' }));
    await expect(seed(s.options, s.deps)).rejects.toThrow(/reconciliation.*FAILED/);
  });

  it('adds exactly one unreadable message with --with-dlq', async () => {
    const without = setup();
    await seed(without.options, without.deps);
    const withDlq = setup(fakeWallet(), { withDlq: true });
    await seed(withDlq.options, withDlq.deps);
    expect(withDlq.published).toHaveLength(without.published.length + 1);
    const bad = withDlq.published.filter(
      (m) => !validateEvent('OrderReadyForPaymentV1', JSON.parse(m.body)).ok,
    );
    expect(bad).toHaveLength(1);
    expect(JSON.parse(bad[0]!.body)).toEqual({ not: 'a valid event' });
    expect(withDlq.order.lastIndexOf('publish')).toBeGreaterThan(
      withDlq.order.indexOf('POST /reconciliations'),
    );
  });

  it('fails with a clear message when the top-up never succeeds', async () => {
    const s = setup(fakeWallet({ topupStatus: 'REQUESTED' }), { timeoutMs: 3000, pollMs: 1000 });
    const err = await seed(s.options, s.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SeedError);
    expect((err as Error).message).toMatch(/top-up.*did not succeed within 3 s/i);
    expect(s.published).toHaveLength(0);
  });

  it('fails when the top-up is FAILED', async () => {
    const s = setup(fakeWallet({ topupStatus: 'FAILED' }));
    await expect(seed(s.options, s.deps)).rejects.toThrow(/top-up.*FAILED/);
  });

  it('reports an unexpected wallet HTTP status', async () => {
    const s = setup();
    s.deps.fetchImpl = async () => json(500, { message: 'boom' });
    await expect(seed(s.options, s.deps)).rejects.toThrow(/POST \/wallets.*500/);
  });
});

describe('credentials', () => {
  it('prefers the environment, then deploy/.env', () => {
    const file = 'A=1\nBILLING_ECOMMERCE_MQ_PASSWORD=from_file\n';
    expect(resolveMqPassword({ BILLING_ECOMMERCE_MQ_PASSWORD: 'from_env' }, file)).toBe('from_env');
    expect(resolveMqPassword({}, file)).toBe('from_file');
  });

  it('gives an actionable error when the password is missing', () => {
    expect(() => resolveMqPassword({}, undefined)).toThrow(SeedError);
    expect(() => resolveMqPassword({}, 'X=1')).toThrow(
      /BILLING_ECOMMERCE_MQ_PASSWORD.*deploy\/\.env/,
    );
  });

  it('parses env files ignoring comments and quotes', () => {
    expect(parseEnvFile('# c\nA=1\n\nB="two"\nC=a=b\n')).toEqual({ A: '1', B: 'two', C: 'a=b' });
  });

  it('builds the AMQP url for vhost billing with an encoded password', () => {
    expect(buildAmqpUrl('localhost', 15673, 'p@ss')).toBe(
      'amqp://ecommerce_orders:p%40ss@localhost:15673/billing',
    );
  });
});
