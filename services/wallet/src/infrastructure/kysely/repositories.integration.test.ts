import { Money } from '@billing/money';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '../../application/errors.js';
import { Account } from '../../domain/account.js';
import { CustomerId } from '../../domain/customer-id.js';
import { LedgerTransaction } from '../../domain/ledger-transaction.js';
import { Topup } from '../../domain/topup.js';
import { createHarness, type Harness } from '../../test-support.js';

const t0 = new Date('2026-10-10T10:00:00.000Z');
const plus = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const wallet = (customer: string, currency: 'VND' | 'USD' = 'VND', now = t0) =>
  Account.openWallet({ customerId: CustomerId.parse(customer), currency, now });

const requestTopup = (id: string, customer: string, amount: number, now = t0) =>
  Topup.request({
    id,
    customerId: CustomerId.parse(customer),
    accountId: `wallet:${customer}`,
    amount: Money.of(amount, 'VND'),
    now,
  });

describe('AccountRepository', () => {
  it('inserts and finds a wallet, round-tripping every field including milliseconds', async () => {
    const account = wallet('r1', 'USD', new Date('2026-10-10T10:00:00.007Z'));
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(account));
    const found = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:r1'));
    expect(found?.toProps()).toEqual(account.toProps());
    expect(await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:nope'))).toBeNull();
  });

  it('answers DuplicateKeyError for a second wallet of the same customer', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('r2')));
    const again = h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('r2', 'USD')));
    await expect(again).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('finds the seeded system accounts', async () => {
    const gateway = await h.uow.run(h.acme, ({ accounts }) => accounts.find('system:GATEWAY:VND'));
    expect(gateway?.toProps()).toMatchObject({
      kind: 'GATEWAY',
      currency: 'VND',
      customerId: null,
    });
  });

  it('locks several accounts in ascending id order regardless of the order asked, and persists balances', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('r3')));
    const locked = await h.uow.run(h.acme, async ({ accounts }) => {
      const rows = await accounts.lockMany(['wallet:r3', 'system:GATEWAY:VND']);
      const [gateway, w] = rows;
      if (!gateway || !w) throw new Error('expected two accounts');
      await accounts.saveBalance(w.apply(Money.of(70, 'VND')));
      await accounts.saveBalance(gateway.apply(Money.of(-70, 'VND')));
      return rows.map((r) => r.toProps().id);
    });
    expect(locked).toEqual(['system:GATEWAY:VND', 'wallet:r3']);
    const after = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:r3'));
    expect(after?.toProps().balance.amount).toBe(70);
  });

  it('fails loudly when asked to lock an account that does not exist', async () => {
    const lock = h.uow.run(h.acme, ({ accounts }) => accounts.lockMany(['wallet:ghost']));
    await expect(lock).rejects.toThrow(/wallet:ghost/);
  });
});

describe('AccountRepository freeze state', () => {
  it('saves frozen state and reads it back through find and lockMany, then unfreezes to null', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('fz1')));
    const at = new Date('2026-10-11T08:30:00.123Z');
    await h.uow.run(h.acme, async ({ accounts }) => {
      const [w] = await accounts.lockMany(['wallet:fz1']);
      if (!w) throw new Error('missing');
      await accounts.saveFrozen(w.freeze('ops1', 'fraud suspected', at));
    });
    const expected = { at, by: 'ops1', reason: 'fraud suspected' };
    const found = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:fz1'));
    expect(found?.toProps().frozen).toEqual(expected);
    const locked = await h.uow.run(h.acme, ({ accounts }) => accounts.lockMany(['wallet:fz1']));
    expect(locked[0]?.toProps().frozen).toEqual(expected);

    await h.uow.run(h.acme, async ({ accounts }) => {
      const [w] = await accounts.lockMany(['wallet:fz1']);
      if (!w) throw new Error('missing');
      await accounts.saveFrozen(w.unfreeze());
    });
    const after = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:fz1'));
    expect(after?.toProps().frozen).toBeNull();
    const raw = await sql<{
      frozen_at: Date | null;
      frozen_by: string | null;
      frozen_reason: string | null;
    }>`
      select frozen_at, frozen_by, frozen_reason from ${sql.id('t_acme', 'accounts')}
      where id = ${'wallet:fz1'}`.execute(h.db);
    expect(raw.rows[0]).toEqual({ frozen_at: null, frozen_by: null, frozen_reason: null });
  });
});

describe('LedgerRepository', () => {
  it('posts a transaction with its entries and lists them in order with a keyset cursor', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('l1')));
    for (const [id, topupId, amount] of [
      ['tx_l1', 'tp_l1', 100],
      ['tx_l2', 'tp_l2', 40],
    ] as const) {
      await h.uow.run(h.acme, ({ ledger }) =>
        ledger.post(
          LedgerTransaction.topup({
            id,
            topupId,
            walletAccountId: 'wallet:l1',
            gatewayAccountId: 'system:GATEWAY:VND',
            amount: Money.of(amount, 'VND'),
            now: t0,
          }),
        ),
      );
    }
    const all = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 10 }),
    );
    expect(all.map((e) => [e.businessKey, e.amount])).toEqual([
      ['topup:tp_l1', 100],
      ['topup:tp_l2', 40],
    ]);
    expect(all[0]?.createdAt).toEqual(t0);

    const firstId = all[0]?.entryId ?? 0;
    const rest = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: firstId, limit: 10 }),
    );
    expect(rest.map((e) => e.businessKey)).toEqual(['topup:tp_l2']);
    const limited = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 1 }),
    );
    expect(limited).toHaveLength(1);
  });

  it('answers DuplicateKeyError for a second posting under the same business key and keeps nothing of it', async () => {
    const make = (id: string) =>
      LedgerTransaction.topup({
        id,
        topupId: 'tp_dup',
        walletAccountId: 'wallet:l1',
        gatewayAccountId: 'system:GATEWAY:VND',
        amount: Money.of(5, 'VND'),
        now: t0,
      });
    await h.uow.run(h.acme, ({ ledger }) => ledger.post(make('tx_d1')));
    const before = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 100 }),
    );
    await expect(
      h.uow.run(h.acme, ({ ledger }) => ledger.post(make('tx_d2'))),
    ).rejects.toBeInstanceOf(DuplicateKeyError);
    const afterwards = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 100 }),
    );
    expect(afterwards).toHaveLength(before.length);
  });
});

describe('TopupRepository', () => {
  it('round-trips a topup including milliseconds, null columns and a bigint amount', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('t1')));
    // Vượt trần API (MAX_TOPUP_AMOUNT) nên dựng lại từ props: ở đây chỉ kiểm cột bigint đọc/ghi đúng.
    const base = requestTopup('tp_t1', 't1', 10, new Date('2026-10-10T10:00:00.003Z'));
    const topup = Topup.rehydrate({
      ...base.toProps(),
      amount: Money.of(Number.MAX_SAFE_INTEGER, 'VND'),
    });
    await h.uow.run(h.acme, ({ topups }) => topups.insert(topup));
    const found = await h.uow.run(h.acme, ({ topups }) => topups.findById('tp_t1'));
    expect(found?.toProps()).toEqual(topup.toProps());
    expect(await h.uow.run(h.acme, ({ topups }) => topups.findById('tp_none'))).toBeNull();
  });

  it('saves state transitions', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('t2')));
    const topup = requestTopup('tp_t2', 't2', 10);
    await h.uow.run(h.acme, ({ topups }) => topups.insert(topup));
    await h.uow.run(h.acme, ({ topups }) => topups.save(topup.recordSubmitted('ch_1')));
    const found = await h.uow.run(h.acme, ({ topups }) => topups.findById('tp_t2'));
    expect(found?.toProps()).toMatchObject({
      status: 'PENDING',
      chargeId: 'ch_1',
      attempts: 1,
      nextAttemptAt: null,
    });
  });

  it('lockNextDue() returns the oldest due REQUESTED topup and ignores the rest', async () => {
    for (const customer of ['n1', 'n2', 'n3', 'n4']) {
      await h.uow.run(h.beta, ({ accounts }) => accounts.insert(wallet(customer)));
    }
    await h.uow.run(h.beta, async ({ topups }) => {
      await topups.insert(requestTopup('tp_n1', 'n1', 1, plus(0)));
      await topups.insert(requestTopup('tp_n2', 'n2', 1, plus(5)));
      const pending = requestTopup('tp_n3', 'n3', 1, plus(0));
      await topups.insert(pending);
      await topups.save(pending.recordSubmitted('ch_n3'));
      await topups.insert(requestTopup('tp_n4', 'n4', 1, plus(100)));
    });
    const next = (now: Date) => h.uow.run(h.beta, ({ topups }) => topups.lockNextDue(now));
    expect((await next(plus(1)))?.toProps().id).toBe('tp_n1');
    expect((await next(plus(6)))?.toProps().id).toBe('tp_n1');
    expect(
      await h.uow.run(h.beta, ({ topups }) => topups.lockNextDue(new Date(t0.getTime() - 1))),
    ).toBeNull();
  });

  it('lockNextDue() skips a topup another open transaction holds (READPAST)', async () => {
    for (const customer of ['p1', 'p2']) {
      await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet(customer)));
    }
    await h.uow.run(h.acme, async ({ topups }) => {
      await topups.insert(requestTopup('tp_p1', 'p1', 1, plus(-20)));
      await topups.insert(requestTopup('tp_p2', 'p2', 1, plus(-10)));
    });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: (id: string | undefined) => void;
    const lockedId = new Promise<string | undefined>((resolve) => (locked = resolve));

    const first = h.uow.run(h.acme, async ({ topups }) => {
      const row = await topups.lockNextDue(t0);
      locked(row?.toProps().id);
      await hold;
    });
    expect(await lockedId).toBe('tp_p1');

    const second = await h.uow.run(h.acme, ({ topups }) => topups.lockNextDue(t0));
    expect(second?.toProps().id).toBe('tp_p2');

    release();
    await first;
  });
});

describe('IdempotencyStore and Inbox', () => {
  it('stores and finds a response per customer and key, and rejects a duplicate key', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('i1')));
    await h.uow.run(h.acme, ({ topups }) => topups.insert(requestTopup('tp_i1', 'i1', 5)));
    const record = {
      customerId: 'i1',
      key: 'Key-1',
      requestHash: 'h'.repeat(64),
      responseStatus: 202,
      responseBody: '{"topupId":"tp_i1"}',
      topupId: 'tp_i1',
      createdAt: new Date('2026-10-10T10:00:00.123Z'),
    };
    await h.uow.run(h.acme, ({ idempotency }) => idempotency.save(record));
    expect(await h.uow.run(h.acme, ({ idempotency }) => idempotency.find('i1', 'Key-1'))).toEqual(
      record,
    );
    expect(
      await h.uow.run(h.acme, ({ idempotency }) => idempotency.find('i1', 'key-1')),
    ).toBeNull();
    expect(
      await h.uow.run(h.acme, ({ idempotency }) => idempotency.find('other', 'Key-1')),
    ).toBeNull();
    await expect(
      h.uow.run(h.acme, ({ idempotency }) => idempotency.save(record)),
    ).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('records an inbox message once per consumer', async () => {
    await h.uow.run(h.acme, ({ inbox }) => inbox.record('payment-webhook', 'evt_1', t0));
    await expect(
      h.uow.run(h.acme, ({ inbox }) => inbox.record('payment-webhook', 'evt_1', t0)),
    ).rejects.toBeInstanceOf(DuplicateKeyError);
    await h.uow.run(h.acme, ({ inbox }) => inbox.record('another', 'evt_1', t0));
  });
});

describe('TenantUnitOfWork', () => {
  it('keeps tenants isolated: the same ids in acme and beta are different rows', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('iso')));
    expect(await h.uow.run(h.beta, ({ accounts }) => accounts.find('wallet:iso'))).toBeNull();
    await h.uow.run(h.beta, ({ accounts }) => accounts.insert(wallet('iso', 'USD')));
    const inAcme = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:iso'));
    const inBeta = await h.uow.run(h.beta, ({ accounts }) => accounts.find('wallet:iso'));
    expect(inAcme?.toProps().currency).toBe('VND');
    expect(inBeta?.toProps().currency).toBe('USD');
  });

  it('rolls everything back when the work throws', async () => {
    const failing = h.uow.run(h.acme, async ({ accounts }) => {
      await accounts.insert(wallet('rollback'));
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    expect(await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:rollback'))).toBeNull();
  });
});

describe('LedgerRepository findTransaction and reversals', () => {
  const topup = (id: string, topupId: string, amount: number) =>
    LedgerTransaction.topup({
      id,
      topupId,
      walletAccountId: 'wallet:rv1',
      gatewayAccountId: 'system:GATEWAY:VND',
      amount: Money.of(amount, 'VND'),
      now: t0,
    });

  it('finds a transaction with its entries and currencies, or null', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('rv1')));
    await h.uow.run(h.acme, ({ ledger }) => ledger.post(topup('tx_rv1', 'tp_rv1', 250)));
    const found = await h.uow.run(h.acme, ({ ledger }) => ledger.findTransaction('tx_rv1'));
    expect(found?.id).toBe('tx_rv1');
    expect(found?.kind).toBe('TOPUP');
    const byAccount = Object.fromEntries(
      (found?.entries ?? []).map((e) => [e.accountId, e.amount.amount]),
    );
    expect(byAccount).toEqual({ 'wallet:rv1': 250, 'system:GATEWAY:VND': -250 });
    expect(found?.entries.every((e) => e.amount.currency === 'VND')).toBe(true);
    expect(await h.uow.run(h.acme, ({ ledger }) => ledger.findTransaction('nope'))).toBeNull();
  });

  it('reports the reversal of a transaction once posted, and refuses a second reversal', async () => {
    await h.uow.run(h.acme, ({ ledger }) => ledger.post(topup('tx_rv2', 'tp_rv2', 90)));
    expect(await h.uow.run(h.acme, ({ ledger }) => ledger.findReversalOf('tx_rv2'))).toBeNull();
    const reverse = (id: string) =>
      h.uow.run(h.acme, async ({ ledger }) => {
        const original = await ledger.findTransaction('tx_rv2');
        if (!original) throw new Error('missing original');
        await ledger.post(LedgerTransaction.reversal({ id, original, now: t0 }));
      });
    await reverse('tx_rv2_rev');
    expect(await h.uow.run(h.acme, ({ ledger }) => ledger.findReversalOf('tx_rv2'))).toBe(
      'tx_rv2_rev',
    );
    const stored = await h.uow.run(h.acme, ({ ledger }) => ledger.findTransaction('tx_rv2_rev'));
    expect(stored?.kind).toBe('REVERSAL');
    // Khóa nghiệp vụ khác hẳn, nên chỉ unique index trên reverses_transaction_id có thể chặn.
    const distinctKey = h.uow.run(h.acme, async ({ ledger }) => {
      const original = await ledger.findTransaction('tx_rv2');
      if (!original) throw new Error('missing original');
      await ledger.post(
        LedgerTransaction.create({
          id: 'tx_rv2_rev3',
          businessKey: 'reversal:other-key',
          kind: 'REVERSAL',
          entries: original.entries.map((e) => ({
            accountId: e.accountId,
            amount: e.amount.negate(),
          })),
          reverses: original.id,
          now: t0,
        }),
      );
    });
    await expect(distinctKey).rejects.toSatisfy(
      (error: unknown) => error instanceof DuplicateKeyError && error.source === 'ledger',
    );
    await expect(reverse('tx_rv2_rev2')).rejects.toSatisfy(
      (error: unknown) => error instanceof DuplicateKeyError && error.source === 'ledger',
    );
  });

  it('keeps reverses_transaction_id null for ordinary transactions', async () => {
    await h.uow.run(h.acme, ({ ledger }) => ledger.post(topup('tx_rv3', 'tp_rv3', 10)));
    const rows = await sql<{ reverses_transaction_id: string | null }>`
      select reverses_transaction_id from ${sql.id('t_acme', 'ledger_transactions')}
      where id = ${'tx_rv3'}`.execute(h.db);
    expect(rows.rows[0]?.reverses_transaction_id).toBeNull();
  });
});
