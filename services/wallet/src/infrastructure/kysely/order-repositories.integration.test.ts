import { Money } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '../../application/errors.js';
import type { NewOutboxMessage } from '../../application/ports.js';
import { Account } from '../../domain/account.js';
import { CustomerId } from '../../domain/customer-id.js';
import { LedgerTransaction } from '../../domain/ledger-transaction.js';
import { createHarness, type Harness } from '../../test-support.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.123Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

beforeAll(async () => {
  h = await createHarness();
  for (const tenant of [h.acme, h.beta]) {
    await h.uow.run(tenant, ({ accounts }) =>
      accounts.insert(
        Account.openWallet({ customerId: CustomerId.parse('c1'), currency: 'VND', now: t0 }),
      ),
    );
  }
});
afterAll(async () => {
  await h.close();
});
// `lockNextDue` trả dòng đến hạn CŨ NHẤT của tenant, nên mỗi ca bắt đầu từ outbox "sạch" (mọi dòng cũ coi như đã gửi).
beforeEach(async () => {
  for (const schema of ['t_acme', 't_beta']) {
    await h.db.withSchema(schema).updateTable('outbox').set({ status: 'SENT' }).execute();
  }
});

const message = (id: string, createdAt = t0): NewOutboxMessage => ({
  id,
  eventType: 'OrderPaidV1',
  routingKey: 'order-paid.v1',
  payload: JSON.stringify({ id }),
  correlationId: 'corr-1',
  createdAt,
});

async function postOrderTransaction(tenant = h.acme, id = 'tx_a', orderId = 'o1'): Promise<void> {
  await h.uow.run(tenant, ({ ledger }) =>
    ledger.post(
      LedgerTransaction.orderPayment({
        id,
        orderId,
        walletAccountId: 'wallet:c1',
        merchantAccountId: 'system:MERCHANT:VND',
        amount: Money.of(1000, 'VND'),
        now: t0,
      }),
    ),
  );
}

describe('KyselyOrderPaymentRepository', () => {
  it('round-trips a paid order with exact money and milliseconds', async () => {
    await postOrderTransaction(h.acme, 'tx_a', 'o1');
    const paid = {
      orderId: 'o1',
      customerId: 'c1',
      walletTransactionId: 'tx_a',
      amount: Money.of(1000, 'VND'),
      paidAt: t0,
    };
    await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.insert(paid));
    const found = await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.find('o1'));
    expect(found).toEqual(paid);
  });

  it('answers null for an unknown order and for an order of another tenant', async () => {
    expect(await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.find('nope'))).toBeNull();
    expect(await h.uow.run(h.beta, ({ orderPayments }) => orderPayments.find('o1'))).toBeNull();
  });

  it('refuses a second payment for the same order with a DuplicateKeyError tagged order_payment', async () => {
    await postOrderTransaction(h.acme, 'tx_b', 'o9');
    const paid = {
      orderId: 'o9',
      customerId: 'c1',
      walletTransactionId: 'tx_b',
      amount: Money.of(1000, 'VND'),
      paidAt: t0,
    };
    await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.insert(paid));
    await expect(
      h.uow.run(h.acme, ({ orderPayments }) => orderPayments.insert(paid)),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof DuplicateKeyError && error.source === 'order_payment',
    );
  });
});

describe('KyselyOutboxRepository', () => {
  it('adds PENDING rows that are due at their creation time, oldest first', async () => {
    await h.uow.run(h.acme, async ({ outbox }) => {
      await outbox.add(message('ob_2', at(2)));
      await outbox.add(message('ob_1', at(1)));
    });
    expect(await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(0)))).toBeNull();
    const first = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(5)));
    expect(first).toEqual({
      id: 'ob_1',
      eventType: 'OrderPaidV1',
      routingKey: 'order-paid.v1',
      payload: JSON.stringify({ id: 'ob_1' }),
      correlationId: 'corr-1',
      createdAt: at(1),
      attempts: 0,
      nextAttemptAt: at(1),
    });
  });

  it('does not hand the same row out again while it is leased, and gives it back after the lease', async () => {
    await h.uow.run(h.acme, ({ outbox }) => outbox.add(message('ob_lease', at(100))));
    const claimed = await h.uow.run(h.acme, async ({ outbox }) => {
      const row = await outbox.lockNextDue(at(100));
      if (row) await outbox.lease(row.id, at(160));
      return row;
    });
    expect(claimed?.id).toBe('ob_lease');
    const during = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(130)));
    expect(during).toBeNull();
    const after = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(161)));
    expect(after?.id).toBe('ob_lease');
  });

  it('records a failure by counting the attempt and rescheduling, and a send by retiring the row', async () => {
    await h.uow.run(h.acme, ({ outbox }) => outbox.add(message('ob_fail', at(200))));
    await h.uow.run(h.acme, ({ outbox }) => outbox.recordFailure('ob_fail', at(210)));
    const retry = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(210)));
    expect(retry).toMatchObject({ id: 'ob_fail', attempts: 1, nextAttemptAt: at(210) });

    await h.uow.run(h.acme, ({ outbox }) => outbox.markSent('ob_fail', at(211)));
    const row = await h.db
      .withSchema('t_acme')
      .selectFrom('outbox')
      .selectAll()
      .where('id', '=', 'ob_fail')
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'SENT', sent_at: at(211) });
    expect(await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(9999)))).toBeNull();
  });

  it('lets two concurrent transactions each take a different due row (READPAST)', async () => {
    await h.uow.run(h.beta, async ({ outbox }) => {
      await outbox.add(message('rp_1', at(300)));
      await outbox.add(message('rp_2', at(301)));
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstId: string | undefined;
    const first = h.uow.run(h.beta, async ({ outbox }) => {
      firstId = (await outbox.lockNextDue(at(400)))?.id;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await h.uow.run(h.beta, ({ outbox }) => outbox.lockNextDue(at(400)));
    release();
    await first;
    expect(firstId).toBe('rp_1');
    expect(second?.id).toBe('rp_2');
  });

  it('keeps tenants apart', async () => {
    await h.uow.run(h.acme, ({ outbox }) => outbox.add(message('ob_acme_only', at(500))));
    expect(await h.uow.run(h.beta, ({ outbox }) => outbox.lockNextDue(at(900)))).toBeNull();
    expect((await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(900))))?.id).toBe(
      'ob_acme_only',
    );
  });
});
