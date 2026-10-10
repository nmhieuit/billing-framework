import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { createHarness, seedTopup, silentLogger, type Harness } from '../../test-support.js';
import { tamperLedger } from '../../test-support-reconciliation.js';
import { KyselyReconciliationRepository } from './reconciliation.repository.js';

// Database riêng: test này cố ý phá sổ cái nên không dùng chung với test khác.
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const inTx = <T>(work: (r: KyselyReconciliationRepository) => Promise<T>) =>
  h.db.transaction().execute((trx) => work(new KyselyReconciliationRepository(trx, 't_acme')));

describe('ledger check confirm step', () => {
  it('drops a transient candidate that is actually consistent and keeps a persistent one', async () => {
    const funded = await seedTopup(h, { state: 'PENDING', amount: 9000 });
    await new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
    }).execute({
      tenant: h.acme,
      eventId: 'evt_confirm_1',
      type: 'charge.succeeded',
      chargeId: funded.chargeId,
      reference: funded.topupId,
      amount: funded.amount,
      currency: funded.currency,
    });
    const account = (
      await h.db
        .withSchema('t_acme')
        .selectFrom('accounts')
        .select('id')
        .where('customer_id', '=', funded.customer)
        .executeTakeFirstOrThrow()
    ).id;
    const tx = await h.db
      .withSchema('t_acme')
      .selectFrom('ledger_transactions')
      .select('id')
      .where('business_key', '=', `topup:${funded.topupId}`)
      .executeTakeFirstOrThrow();

    // Ứng viên "thoáng qua" (bước 1 thấy lệch do đọc lệch thời điểm): thực ra nhất quán nên bị loại.
    expect(await inTx((r) => r.confirmBalanceMismatches([account]))).toEqual([]);
    expect(await inTx((r) => r.confirmUnbalanced([tx.id]))).toEqual([]);
    expect(await inTx((r) => r.findBalanceMismatches())).toEqual([]);
    expect(await inTx((r) => r.findUnbalancedTransactions())).toEqual([]);

    // Lệch bền vững vẫn được báo.
    await tamperLedger(h, account);
    expect(await inTx((r) => r.confirmBalanceMismatches([account]))).toEqual([
      { accountId: account, balance: 9005, ledgerTotal: 9000 },
    ]);
    expect(await inTx((r) => r.confirmUnbalanced(['tx_bad']))).toEqual([
      { transactionId: 'tx_bad', total: 7 },
    ]);
    expect((await inTx((r) => r.findBalanceMismatches())).map((m) => m.accountId)).toContain(
      account,
    );
    expect(await inTx((r) => r.findUnbalancedTransactions())).toEqual([
      { transactionId: 'tx_bad', total: 7 },
    ]);
  });
});
