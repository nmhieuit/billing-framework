import { validateEvent } from '@billing/contracts';
import { FakePaymentServer, createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type RunningService, type StartOverrides } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import { createHarness, fundWallet, type Harness } from './test-support.js';
import { OrdersSimulator, peekQueue, queueDepth } from './test-support-orders.js';

let h: Harness;
let payment: FakePaymentServer;
let counter = 0;
const DLQ = 'wallet.order-payments.dlq';

beforeAll(async () => {
  h = await createHarness();
  payment = await FakePaymentServer.start();
});
afterAll(async () => {
  await payment.close();
  await h.close();
});

const configFor = (broker: TestBroker): WalletConfig => ({
  port: 0,
  database: h.config,
  tenants: [h.acme, h.beta],
  payment: { baseUrl: payment.baseUrl, webhookSecret: 'whsec_orders_e2e', timeoutMs: 1000 },
  broker: broker.wallet,
  orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
  topupBackoffSeconds: [1],
  workerIntervalMs: 50,
});

interface Stack {
  broker: TestBroker;
  service: RunningService;
  orders: OrdersSimulator;
  stop(): Promise<void>;
}

async function startStack(
  overrides: StartOverrides = {},
  options: { bindResults?: boolean } = {},
): Promise<Stack> {
  const broker = await createTestBroker('orders');
  const orders = await OrdersSimulator.connect(broker.ecommerce, options);
  const service = await startService(configFor(broker), overrides);
  return {
    broker,
    service,
    orders,
    async stop() {
      await service.stop();
      await orders.close();
      await broker.drop();
    },
  };
}

const newCustomer = () => `oc${++counter}`;
const balance = async (customer: string, tenant = 'acme'): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema(`t_${tenant}`)
        .selectFrom('accounts')
        .select('balance')
        .where('id', '=', `wallet:${customer}`)
        .executeTakeFirstOrThrow()
    ).balance,
  );
const ledgerCount = async (orderId: string, tenant = 'acme'): Promise<number> =>
  (
    await h.db
      .withSchema(`t_${tenant}`)
      .selectFrom('ledger_transactions')
      .select('id')
      .where('business_key', '=', `order:${orderId}`)
      .execute()
  ).length;
const quiet = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));

describe('order payment over RabbitMQ (wallet + simulated orders)', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack.stop();
  });

  it('pays an order from the wallet and reports OrderPaidV1 with the ledger transaction id', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 40000 });

    await stack.orders.publish(event);
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, { timeoutMs: 15_000 });

    const [result] = stack.orders.resultsFor(event.orderId);
    expect(result?.type).toBe('OrderPaidV1');
    expect(validateEvent('OrderPaidV1', result?.body).ok).toBe(true);
    expect(result?.messageId).toBe(result?.body.eventId);
    expect(result?.body).toMatchObject({
      orderId: event.orderId,
      amount: 40000,
      currency: 'VND',
      tenantId: 'acme',
      correlationId: event.correlationId,
    });
    expect(await balance(customer)).toBe(60000);

    const entries = await stack.service.app.inject({
      method: 'GET',
      url: '/wallet/entries',
      headers: { 'x-tenant-id': 'acme', 'x-customer-id': customer },
    });
    expect(
      entries.json<{
        items: Array<{ businessKey: string; amount: number; transactionId: string }>;
      }>().items,
    ).toContainEqual(
      expect.objectContaining({
        businessKey: `order:${event.orderId}`,
        amount: -40000,
        transactionId: result?.body.walletTransactionId,
      }),
    );
  });

  it.each([
    [
      'INSUFFICIENT_FUNDS',
      async (c: string) => stack.orders.ready({ customerId: c, amount: 999999 }),
      true,
    ],
    ['WALLET_NOT_FOUND', async () => stack.orders.ready({ customerId: 'nobody-has-this' }), false],
    [
      'CURRENCY_MISMATCH',
      async (c: string) => stack.orders.ready({ customerId: c, currency: 'USD', amount: 10 }),
      true,
    ],
  ])(
    'reports OrderPaymentFailedV1(%s) and leaves the wallet untouched',
    async (reason, make, funded) => {
      const customer = newCustomer();
      if (funded) await fundWallet(h, { customer, amount: 100000 });
      const event = await make(customer);
      await stack.orders.publish(event);
      await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, {
        timeoutMs: 15_000,
      });
      const [result] = stack.orders.resultsFor(event.orderId);
      expect(result?.type).toBe('OrderPaymentFailedV1');
      expect(validateEvent('OrderPaymentFailedV1', result?.body).ok).toBe(true);
      expect(result?.body.reason).toBe(reason);
      if (funded) expect(await balance(customer)).toBe(100000);
    },
  );

  it('lets a refused order be paid after the customer tops up (a refusal is not remembered)', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    const first = stack.orders.ready({ customerId: customer, amount: 5000 });
    await stack.orders.publish(first);
    await waitFor(() => stack.orders.resultsFor(first.orderId).length === 1, {
      timeoutMs: 15_000,
    });
    expect(stack.orders.resultsFor(first.orderId)[0]?.type).toBe('OrderPaymentFailedV1');

    await fundWallet(h, { customer, amount: 10000 });
    await stack.orders.publish({ ...first, eventId: stack.orders.ready().eventId });
    await waitFor(() => stack.orders.resultsFor(first.orderId).length === 2, {
      timeoutMs: 15_000,
    });
    expect(stack.orders.resultsFor(first.orderId)[1]?.type).toBe('OrderPaidV1');
    expect(await balance(customer)).toBe(6000);
  });

  it('charges once when the broker delivers the same event again, and says nothing the second time', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 30000 });
    await stack.orders.publish(event);
    await stack.orders.publish(event);
    await waitFor(() => stack.orders.resultsFor(event.orderId).length >= 1, {
      timeoutMs: 15_000,
    });
    await quiet();
    expect(stack.orders.resultsFor(event.orderId)).toHaveLength(1);
    expect(await balance(customer)).toBe(70000);
    expect(await ledgerCount(event.orderId)).toBe(1);
  });

  it('replays OrderPaidV1 with the same wallet transaction when the order is requested again under a new event id', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 30000 });
    await stack.orders.publish(event);
    await stack.orders.publish({ ...event, eventId: stack.orders.ready().eventId });
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 2, {
      timeoutMs: 15_000,
    });
    const [a, b] = stack.orders.resultsFor(event.orderId);
    expect(a?.body.walletTransactionId).toBe(b?.body.walletTransactionId);
    expect(a?.body.eventId).not.toBe(b?.body.eventId);
    expect(await balance(customer)).toBe(70000);
    expect(await ledgerCount(event.orderId)).toBe(1);
  });

  it('refuses a conflicting repeat (same order, different amount) with CONFLICT and does not charge again', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 30000 });
    await stack.orders.publish(event);
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, {
      timeoutMs: 15_000,
    });
    await stack.orders.publish({
      ...event,
      eventId: stack.orders.ready().eventId,
      amount: 31000,
    });
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 2, {
      timeoutMs: 15_000,
    });
    expect(stack.orders.resultsFor(event.orderId)[1]?.body.reason).toBe('CONFLICT');
    expect(await balance(customer)).toBe(70000);
  });

  it('charges exactly once when the same event is published twenty times at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 20000 });
    await Promise.all(Array.from({ length: 20 }, () => stack.orders.publish(event)));
    await waitFor(() => stack.orders.resultsFor(event.orderId).length >= 1, {
      timeoutMs: 20_000,
    });
    await quiet(2500);
    expect(stack.orders.resultsFor(event.orderId)).toHaveLength(1);
    expect(await balance(customer)).toBe(80000);
    expect(await ledgerCount(event.orderId)).toBe(1);
  });

  it('charges exactly once when the same order arrives under ten different event ids at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const base = stack.orders.ready({ customerId: customer, amount: 20000 });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        stack.orders.publish({ ...base, eventId: stack.orders.ready().eventId }),
      ),
    );
    await waitFor(() => stack.orders.resultsFor(base.orderId).length === 10, {
      timeoutMs: 30_000,
    });
    const transactions = new Set(
      stack.orders.resultsFor(base.orderId).map((r) => r.body.walletTransactionId),
    );
    expect(transactions.size).toBe(1);
    expect(await balance(customer)).toBe(80000);
    expect(await ledgerCount(base.orderId)).toBe(1);
  });

  it('dead-letters unreadable, schema-invalid and unknown-tenant messages without touching any wallet', async () => {
    const before = await queueDepth(stack.broker.admin, DLQ);
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 5000 });
    await stack.orders.publishRaw('{this is not json');
    await stack.orders.publish(stack.orders.ready({ customerId: customer, amount: 0 }));
    await stack.orders.publish(stack.orders.ready({ customerId: customer, tenantId: 'ghost' }));
    await waitFor(async () => (await queueDepth(stack.broker.admin, DLQ)) === before + 3, {
      timeoutMs: 15_000,
    });
    expect(await balance(customer)).toBe(5000);
    const dead = await peekQueue(stack.broker.admin, DLQ);
    expect(String(dead?.headers['x-dead-letter-reason'] ?? '')).not.toBe('');
  });
});

describe('order payment — failure modes', () => {
  it('does not lose the result when nobody is bound to receive it yet: the outbox retries until the consumer queue exists', async () => {
    const stack = await startStack({}, { bindResults: false });
    try {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 100000 });
      const event = stack.orders.ready({ customerId: customer, amount: 25000 });
      await stack.orders.publish(event);

      await waitFor(
        async () => {
          const rows = await h.db
            .withSchema('t_acme')
            .selectFrom('outbox')
            .select(['attempts', 'status'])
            .where('payload', 'like', `%${event.orderId}%`)
            .execute();
          return rows.length === 1 && rows[0]!.status === 'PENDING' && rows[0]!.attempts >= 1;
        },
        { timeoutMs: 15_000 },
      );
      expect(stack.orders.results).toHaveLength(0);

      await stack.orders.bindResults();
      await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, {
        timeoutMs: 30_000,
      });
      expect(stack.orders.resultsFor(event.orderId)[0]?.type).toBe('OrderPaidV1');
      expect(await balance(customer)).toBe(75000);
    } finally {
      await stack.stop();
    }
  });

  it('survives a consumer that dies after the payment committed but before it acknowledged', async () => {
    let killed = false;
    const holder: { broker?: TestBroker } = {};
    const stack = await startStack({
      afterOrderHandled: async () => {
        if (killed || !holder.broker) return;
        killed = true;
        await holder.broker.closeConnections({ user: 'billing_wallet' });
      },
    });
    holder.broker = stack.broker;
    try {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 100000 });
      const event = stack.orders.ready({ customerId: customer, amount: 45000 });
      await stack.orders.publish(event);

      await waitFor(() => stack.orders.resultsFor(event.orderId).length >= 1, {
        timeoutMs: 60_000,
        intervalMs: 200,
      });
      await quiet(2500);
      expect(killed).toBe(true);
      expect(stack.orders.resultsFor(event.orderId)).toHaveLength(1);
      expect(await balance(customer)).toBe(55000);
      expect(await ledgerCount(event.orderId)).toBe(1);
    } finally {
      await stack.stop();
    }
  }, 90_000);

  it('refuses to start when the broker vhost does not exist, and releases what it had opened', async () => {
    const broker = await createTestBroker('orders');
    try {
      await expect(
        startService({
          ...configFor(broker),
          broker: { ...broker.wallet, vhost: 'no-such-vhost' },
        }),
      ).rejects.toThrow();
    } finally {
      await broker.drop();
    }
  }, 60_000);
});
