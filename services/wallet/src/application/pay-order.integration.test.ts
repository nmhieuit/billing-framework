import { randomUUID } from 'node:crypto';
import { validateEvent } from '@billing/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import {
  createHarness,
  expectLedgerInvariants,
  fundWallet,
  seedTopup,
  silentLogger,
  type Harness,
} from '../test-support.js';
import { ApplyPaymentResult } from './apply-payment-result.js';
import { PayOrder, type PayOrderInput } from './pay-order.js';
import type { Logger } from './ports.js';

let h: Harness;
let pay: PayOrder;
let warnings: object[];
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  warnings = [];
  const log: Logger = { ...silentLogger, warn: (details) => warnings.push(details) };
  pay = new PayOrder({ uow: h.uow, clock: h.clock, ids: h.ids, log });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const newCustomer = () => `pc${++counter}`;
const order = (customer: string, overrides: Partial<PayOrderInput> = {}): PayOrderInput => ({
  tenant: h.acme,
  eventId: randomUUID(),
  correlationId: 'corr-1',
  orderId: randomUUID(),
  customerId: customer,
  amount: 50000,
  currency: 'VND',
  ...overrides,
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const balance = async (tenant: TenantId, accountId: string): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema(schema(tenant))
        .selectFrom('accounts')
        .select('balance')
        .where('id', '=', accountId)
        .executeTakeFirstOrThrow()
    ).balance,
  );
const outboxFor = async (orderId: string, tenant = h.acme) =>
  (
    await h.db
      .withSchema(schema(tenant))
      .selectFrom('outbox')
      .selectAll()
      .where('payload', 'like', `%${orderId}%`)
      .orderBy('created_at')
      .execute()
  ).map((row) => ({ ...row, body: JSON.parse(row.payload) as Record<string, unknown> }));
const ledgerFor = async (orderId: string, tenant = h.acme) =>
  h.db
    .withSchema(schema(tenant))
    .selectFrom('ledger_transactions')
    .selectAll()
    .where('business_key', '=', `order:${orderId}`)
    .execute();
const paidRows = async (orderId: string, tenant = h.acme) =>
  h.db
    .withSchema(schema(tenant))
    .selectFrom('order_payments')
    .selectAll()
    .where('order_id', '=', orderId)
    .execute();

describe('PayOrder — paying', () => {
  it('debits the wallet, credits the merchant, posts the ledger, remembers the order and queues OrderPaidV1', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 120000 });
    const merchantBefore = await balance(h.acme, 'system:MERCHANT:VND');
    const input = order(customer);
    h.clock.advanceSeconds(10);

    const outcome = await pay.execute(input);

    expect(outcome.kind).toBe('PAID');
    const transactionId = outcome.kind === 'PAID' ? outcome.walletTransactionId : '';
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(70000);
    expect(await balance(h.acme, 'system:MERCHANT:VND')).toBe(merchantBefore + 50000);
    const [tx] = await ledgerFor(input.orderId);
    expect(tx).toMatchObject({ id: transactionId, kind: 'ORDER_PAYMENT' });
    expect(await paidRows(input.orderId)).toEqual([
      expect.objectContaining({
        customer_id: customer,
        wallet_transaction_id: transactionId,
        currency: 'VND',
        paid_at: new Date('2026-10-10T10:00:10.000Z'),
      }),
    ]);
    const rows = await outboxFor(input.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      event_type: 'OrderPaidV1',
      routing_key: 'order-paid.v1',
      correlation_id: 'corr-1',
    });
    expect(validateEvent('OrderPaidV1', rows[0]?.body).ok).toBe(true);
    expect(rows[0]?.body).toMatchObject({
      orderId: input.orderId,
      walletTransactionId: transactionId,
      amount: 50000,
      currency: 'VND',
      tenantId: 'acme',
    });
  });

  it('can pay with the whole balance, leaving exactly zero', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 50000 });
    expect((await pay.execute(order(customer))).kind).toBe('PAID');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(0);
  });
});

describe('PayOrder — refusals queue OrderPaymentFailedV1 and still commit', () => {
  it('INSUFFICIENT_FUNDS leaves money and ledger alone', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 49999 });
    const input = order(customer);
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(49999);
    expect(await ledgerFor(input.orderId)).toHaveLength(0);
    expect(await paidRows(input.orderId)).toHaveLength(0);
    const rows = await outboxFor(input.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event_type: 'OrderPaymentFailedV1',
      routing_key: 'order-payment-failed.v1',
    });
    expect(rows[0]?.body).toMatchObject({ reason: 'INSUFFICIENT_FUNDS', orderId: input.orderId });
    expect(validateEvent('OrderPaymentFailedV1', rows[0]?.body).ok).toBe(true);
  });

  it.each([
    ['no wallet', 'nobody-here'],
    ['an id that cannot name a wallet', 'bad id!'],
  ])('WALLET_NOT_FOUND for %s', async (_name, customerId) => {
    const input = order(customerId);
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'WALLET_NOT_FOUND' });
    expect((await outboxFor(input.orderId))[0]?.body).toMatchObject({ reason: 'WALLET_NOT_FOUND' });
  });

  it('CURRENCY_MISMATCH when the wallet currency differs from the order currency', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer, { currency: 'USD', amount: 100 });
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'CURRENCY_MISMATCH' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(100000);
  });

  it('does not see a wallet that lives in another tenant', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer, { tenant: h.beta });
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'WALLET_NOT_FOUND' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(100000);
    expect(await outboxFor(input.orderId, h.beta)).toHaveLength(1);
    expect(await outboxFor(input.orderId, h.acme)).toHaveLength(0);
  });

  it('forgets a refusal: after the customer tops up, the same order can be paid', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 10000 });
    const orderId = randomUUID();
    expect((await pay.execute(order(customer, { orderId }))).kind).toBe('REJECTED');
    await fundWallet(h, { customer, amount: 100000 });
    expect((await pay.execute(order(customer, { orderId }))).kind).toBe('PAID');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(60000);
    expect((await outboxFor(orderId)).map((r) => r.event_type)).toEqual([
      'OrderPaymentFailedV1',
      'OrderPaidV1',
    ]);
  });
});

describe('PayOrder — duplicates never charge twice', () => {
  it('answers DUPLICATE for a redelivered event id and queues nothing new', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer);
    expect((await pay.execute(input)).kind).toBe('PAID');
    expect(await pay.execute(input)).toEqual({ kind: 'DUPLICATE' });
    expect(await outboxFor(input.orderId)).toHaveLength(1);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
  });

  it('replays OrderPaidV1 with the same walletTransactionId when the order is requested again under a new event id', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const first = order(customer);
    const paid = await pay.execute(first);
    const again = await pay.execute({ ...first, eventId: randomUUID() });

    expect(again).toEqual({
      kind: 'REPLAYED',
      walletTransactionId: paid.kind === 'PAID' ? paid.walletTransactionId : '?',
    });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
    expect(await ledgerFor(first.orderId)).toHaveLength(1);
    const rows = await outboxFor(first.orderId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body.walletTransactionId).toBe(rows[1]?.body.walletTransactionId);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it.each([
    ['a different amount', { amount: 60000 }],
    ['a different currency', { currency: 'USD', amount: 50 }],
  ])(
    'answers CONFLICT and warns when a paid order comes again with %s',
    async (_name, override) => {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 100000 });
      const first = order(customer);
      await pay.execute(first);
      expect(await pay.execute({ ...first, ...override, eventId: randomUUID() })).toEqual({
        kind: 'REJECTED',
        reason: 'CONFLICT',
      });
      expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
      expect(warnings.length).toBeGreaterThan(0);
    },
  );

  it('answers CONFLICT when a paid order comes again for another customer', async () => {
    const customer = newCustomer();
    const other = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    await fundWallet(h, { customer: other, amount: 100000 });
    const first = order(customer);
    await pay.execute(first);
    expect(await pay.execute({ ...first, customerId: other, eventId: randomUUID() })).toEqual({
      kind: 'REJECTED',
      reason: 'CONFLICT',
    });
    expect(await balance(h.acme, `wallet:${other}`)).toBe(100000);
  });
});

describe('PayOrder — concurrency', () => {
  it('charges once when the same event arrives ten times at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer);
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => pay.execute(input)));
    expect(outcomes.filter((o) => o.kind === 'PAID')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'DUPLICATE')).toHaveLength(9);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
    expect(await ledgerFor(input.orderId)).toHaveLength(1);
  });

  it('charges once when the same order arrives under ten different event ids at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const base = order(customer);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => pay.execute({ ...base, eventId: randomUUID() })),
    );
    expect(outcomes.filter((o) => o.kind === 'PAID')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'REPLAYED')).toHaveLength(9);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
    expect(await ledgerFor(base.orderId)).toHaveLength(1);
    expect(await paidRows(base.orderId)).toHaveLength(1);
  });

  it('never overspends: with money for three of six simultaneous orders exactly three are paid', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 3000 });
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => pay.execute(order(customer, { amount: 1000 }))),
    );
    expect(outcomes.filter((o) => o.kind === 'PAID')).toHaveLength(3);
    expect(outcomes.filter((o) => o.kind === 'REJECTED')).toHaveLength(3);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(0);
  });

  it('a top-up settling while orders are being paid keeps the books exact and deadlock-free', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 5000 });
    const seeded = await seedTopup(h, { customer, amount: 7000 });
    const apply = new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
    });
    const results = await Promise.all([
      apply.execute({
        tenant: h.acme,
        eventId: randomUUID(),
        type: 'charge.succeeded',
        chargeId: seeded.chargeId,
        reference: seeded.topupId,
        amount: 7000,
        currency: 'VND',
      }),
      pay.execute(order(customer, { amount: 2000 })),
      pay.execute(order(customer, { amount: 2000 })),
    ]);
    expect(results[0]).toBe('APPLIED');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(8000);
  });
});

describe('PayOrder — atomicity', () => {
  it('rolls back everything, inbox included, when the ledger id cannot be generated, so the retry pays', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const failing = new PayOrder({
      uow: h.uow,
      clock: h.clock,
      ids: {
        topupId: () => h.ids.topupId(),
        eventId: () => h.ids.eventId(),
        transactionId: () => {
          throw new Error('id generator down');
        },
      },
      log: silentLogger,
    });
    const input = order(customer);
    await expect(failing.execute(input)).rejects.toThrow('id generator down');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(100000);
    expect(await outboxFor(input.orderId)).toHaveLength(0);
    expect((await pay.execute(input)).kind).toBe('PAID');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
  });
});
