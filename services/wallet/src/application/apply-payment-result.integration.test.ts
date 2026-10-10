import { Money, type Currency } from '@billing/money';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import {
  createHarness,
  expectLedgerInvariants,
  seedTopup,
  type Harness,
  type SeededTopup,
} from '../test-support.js';
import { ApplyPaymentResult, type ApplyPaymentResultInput } from './apply-payment-result.js';
import type { Logger } from './ports.js';

interface LogLine {
  level: 'info' | 'warn' | 'error';
  details: object;
  message: string | undefined;
}

let h: Harness;
let apply: ApplyPaymentResult;
let logs: LogLine[];
let eventCounter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  logs = [];
  const log: Logger = {
    info: (details, message) => logs.push({ level: 'info', details, message }),
    warn: (details, message) => logs.push({ level: 'warn', details, message }),
    error: (details, message) => logs.push({ level: 'error', details, message }),
  };
  apply = new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const event = (
  seeded: SeededTopup,
  overrides: Partial<ApplyPaymentResultInput> = {},
): ApplyPaymentResultInput => ({
  tenant: seeded.tenant,
  eventId: `evt_${++eventCounter}`,
  type: 'charge.succeeded',
  chargeId: seeded.chargeId,
  reference: seeded.topupId,
  amount: seeded.amount,
  currency: seeded.currency,
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
const topupRow = async (tenant: TenantId, id: string) =>
  h.db
    .withSchema(schema(tenant))
    .selectFrom('topups')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
const ledgerFor = async (tenant: TenantId, topupId: string) => {
  const transactions = await h.db
    .withSchema(schema(tenant))
    .selectFrom('ledger_transactions')
    .selectAll()
    .where('business_key', '=', `topup:${topupId}`)
    .execute();
  const entries = await h.db
    .withSchema(schema(tenant))
    .selectFrom('ledger_entries')
    .selectAll()
    .where(
      'transaction_id',
      'in',
      transactions.length > 0 ? transactions.map((t) => t.id) : ['none'],
    )
    .execute();
  return { transactions, entries };
};
const gateway = (currency: Currency) => `system:GATEWAY:${currency}`;

describe('ApplyPaymentResult — success', () => {
  it('credits the wallet, debits the gateway, completes the topup and records the event', async () => {
    const seeded = await seedTopup(h);
    const gatewayBefore = await balance(h.acme, gateway('VND'));
    h.clock.advanceSeconds(10);

    expect(await apply.execute(event(seeded))).toBe('APPLIED');

    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'SUCCEEDED',
      charge_id: seeded.chargeId,
      failure_code: null,
      next_attempt_at: null,
      completed_at: new Date('2026-10-10T10:00:10.000Z'),
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect(await balance(h.acme, gateway('VND'))).toBe(gatewayBefore - 150000);
    const { transactions, entries } = await ledgerFor(h.acme, seeded.topupId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      kind: 'TOPUP',
      business_key: `topup:${seeded.topupId}`,
    });
    expect(entries.map((e) => [e.account_id, Number(e.amount)]).sort()).toEqual(
      [
        [`wallet:${seeded.customer}`, 150000],
        [gateway('VND'), -150000],
      ].sort(),
    );
    expect(logs.filter((l) => l.level !== 'info')).toEqual([]);
  });

  it('also settles a topup that is still REQUESTED (webhook arrived before the submit result)', async () => {
    const seeded = await seedTopup(h, { state: 'REQUESTED' });
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'SUCCEEDED',
      charge_id: seeded.chargeId,
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });

  it('works for USD with the USD gateway account', async () => {
    const seeded = await seedTopup(h, { currency: 'USD', amount: 25 });
    const before = await balance(h.acme, gateway('USD'));
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(25);
    expect(await balance(h.acme, gateway('USD'))).toBe(before - 25);
  });

  it('credits a topup that already failed with PAYMENT_UNAVAILABLE (the gateway is the source of truth)', async () => {
    const seeded = await seedTopup(h, { state: 'FAILED_UNAVAILABLE' });
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'SUCCEEDED',
      failure_code: null,
      charge_id: seeded.chargeId,
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });

  it('does not credit a topup that failed with PAYMENT_REJECTED and says so in the log', async () => {
    const seeded = await seedTopup(h, { state: 'FAILED_REJECTED' });
    expect(await apply.execute(event(seeded))).toBe('IGNORED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PAYMENT_REJECTED',
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(0);
    const problems = logs.filter((l) => l.level !== 'info');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      level: 'error',
      message: expect.stringContaining('customer was charged but the wallet was not credited'),
      details: {
        topupStatus: 'FAILED',
        failureCode: 'PAYMENT_REJECTED',
        reference: seeded.topupId,
      },
    });
  });
});

describe('ApplyPaymentResult — failure', () => {
  it('fails a PENDING topup with the gateway failure code and leaves the ledger alone', async () => {
    const seeded = await seedTopup(h);
    h.clock.advanceSeconds(5);
    expect(
      await apply.execute(event(seeded, { type: 'charge.failed', failureCode: 'card_declined' })),
    ).toBe('APPLIED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'card_declined',
      charge_id: seeded.chargeId,
      completed_at: new Date('2026-10-10T10:00:05.000Z'),
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(0);
  });

  it('ignores charge.failed after the topup succeeded, keeps the money, and logs an error', async () => {
    const seeded = await seedTopup(h);
    await apply.execute(event(seeded));
    logs.length = 0;
    expect(
      await apply.execute(event(seeded, { type: 'charge.failed', failureCode: 'card_declined' })),
    ).toBe('IGNORED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('only warns for charge.failed on a topup that is already FAILED (nothing to undo)', async () => {
    const seeded = await seedTopup(h, { state: 'FAILED_REJECTED' });
    expect(
      await apply.execute(event(seeded, { type: 'charge.failed', failureCode: 'card_declined' })),
    ).toBe('IGNORED');
    expect(logs.filter((l) => l.level === 'error')).toEqual([]);
    expect(logs.filter((l) => l.level === 'warn')).toHaveLength(1);
  });
});

describe('ApplyPaymentResult — duplicates', () => {
  it('answers DUPLICATE for the same event id and credits only once', async () => {
    const seeded = await seedTopup(h);
    const first = event(seeded);
    expect(await apply.execute(first)).toBe('APPLIED');
    expect(await apply.execute(first)).toBe('DUPLICATE');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(1);
  });

  it('ignores a second success event (new event id) for a topup that is already SUCCEEDED', async () => {
    const seeded = await seedTopup(h);
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    logs.length = 0;
    expect(await apply.execute(event(seeded))).toBe('IGNORED');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect(logs.map((l) => l.level)).toEqual(['warn']);
  });

  it('answers DUPLICATE and logs an error when the ledger already holds topup:<id> but the topup is not SUCCEEDED', async () => {
    const seeded = await seedTopup(h);
    await h.uow.run(h.acme, async ({ ledger, accounts }) => {
      // Giữ bất biến số dư = tổng dòng sổ: cộng/trừ đúng như một lần ghi thật, chỉ riêng lần nạp vẫn PENDING.
      const locked = await accounts.lockMany([`wallet:${seeded.customer}`, gateway('VND')]);
      const money = Money.of(seeded.amount, 'VND');
      for (const account of locked) {
        const isWallet = account.toProps().id === `wallet:${seeded.customer}`;
        await accounts.saveBalance(account.apply(isWallet ? money : money.negate()));
      }
      await ledger.post(
        LedgerTransaction.topup({
          id: h.ids.transactionId(),
          topupId: seeded.topupId,
          walletAccountId: `wallet:${seeded.customer}`,
          gatewayAccountId: gateway('VND'),
          amount: Money.of(seeded.amount, 'VND'),
          now: h.clock.now(),
        }),
      );
    });
    expect(await apply.execute(event(seeded))).toBe('DUPLICATE');
    const errors = logs.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain(`topup:${seeded.topupId}`);
    expect(errors[0]?.message).toContain('inconsistent');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'PENDING' });
  });

  it('does not log an inbox duplicate as an error', async () => {
    const seeded = await seedTopup(h);
    const first = event(seeded);
    await apply.execute(first);
    logs.length = 0;
    expect(await apply.execute(first)).toBe('DUPLICATE');
    expect(logs).toEqual([]);
  });

  it('applies the same event exactly once when it is delivered concurrently', async () => {
    const seeded = await seedTopup(h);
    const same = event(seeded);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => apply.execute(same)));
    expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(7);
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });

  it('credits once when two different events race for the same topup', async () => {
    const seeded = await seedTopup(h);
    const outcomes = await Promise.all([
      apply.execute(event(seeded)),
      apply.execute(event(seeded)),
    ]);
    expect([...outcomes].sort()).toEqual(['APPLIED', 'IGNORED']);
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(1);
  });

  it('keeps the balance exact when many topups of one wallet are settled concurrently (no deadlock)', async () => {
    const first = await seedTopup(h, { amount: 1000 });
    const rest = await Promise.all(
      Array.from({ length: 5 }, () => seedTopup(h, { customer: first.customer, amount: 1000 })),
    );
    const outcomes = await Promise.all([first, ...rest].map((s) => apply.execute(event(s))));
    expect(outcomes.every((o) => o === 'APPLIED')).toBe(true);
    expect(await balance(h.acme, `wallet:${first.customer}`)).toBe(6000);
  });
});

describe('ApplyPaymentResult — inconsistent events', () => {
  it('answers UNKNOWN_TOPUP for a reference that does not exist, logs an error and still records the event', async () => {
    const seeded = await seedTopup(h);
    const stray = event(seeded, { reference: 'tp_missing' });
    expect(await apply.execute(stray)).toBe('UNKNOWN_TOPUP');
    expect(logs.some((l) => l.level === 'error')).toBe(true);
    expect(await apply.execute(stray)).toBe('DUPLICATE');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
  });

  it('does not see a topup of another tenant', async () => {
    const seeded = await seedTopup(h, { tenant: h.acme });
    expect(await apply.execute(event(seeded, { tenant: h.beta }))).toBe('UNKNOWN_TOPUP');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'PENDING' });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
  });

  it.each([
    ['a different amount', { amount: 149999 }],
    ['a different currency', { currency: 'USD' }],
    ['a different charge id', { chargeId: 'ch_other' }],
  ])('refuses an event with %s without touching the ledger', async (_name, override) => {
    const seeded = await seedTopup(h);
    const mismatched = event(seeded, override);
    expect(await apply.execute(mismatched)).toBe('MISMATCH');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'PENDING',
      completed_at: null,
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(0);
    const sent: Partial<ApplyPaymentResultInput> = override;
    const [line] = logs.filter((l) => l.level === 'error');
    expect(line?.details).toMatchObject({
      amount: sent.amount ?? seeded.amount,
      currency: sent.currency ?? seeded.currency,
      chargeId: sent.chargeId ?? seeded.chargeId,
      expected: { amount: seeded.amount, currency: seeded.currency, chargeId: seeded.chargeId },
    });
    // Sự kiện đã được ghi vào inbox (commit cùng giao dịch): gửi lại cùng eventId là DUPLICATE.
    expect(await apply.execute(mismatched)).toBe('DUPLICATE');
  });

  it('commits the inbox row for an IGNORED event, so re-sending it answers DUPLICATE', async () => {
    const seeded = await seedTopup(h, { state: 'FAILED_REJECTED' });
    const ignored = event(seeded);
    expect(await apply.execute(ignored)).toBe('IGNORED');
    expect(await apply.execute(ignored)).toBe('DUPLICATE');
  });

  it('rolls everything back, including the inbox record, when something fails after the inbox write', async () => {
    const seeded = await seedTopup(h);
    // Bộ sinh mã hỏng: `transactionId()` chỉ được gọi sau khi inbox đã ghi và tài khoản đã khóa, ngay trước khi ghi sổ.
    const failing = new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: {
        topupId: () => h.ids.topupId(),
        transactionId: () => {
          throw new Error('id generator down');
        },
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const first = event(seeded);
    await expect(failing.execute(first)).rejects.toThrow('id generator down');

    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'PENDING',
      completed_at: null,
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    // Nếu inbox không được rollback, lần xử lý lại sẽ bị coi là DUPLICATE và tiền không bao giờ được ghi.
    expect(await apply.execute(first)).toBe('APPLIED');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });
});
