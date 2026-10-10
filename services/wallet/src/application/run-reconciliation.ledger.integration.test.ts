import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, silentLogger, type Harness } from '../test-support.js';
import {
  FakeSettlement,
  chargeFor,
  seedSucceededTopup,
  startDay,
  tamperLedger,
} from '../test-support-reconciliation.js';
import { ApplyPaymentResult } from './apply-payment-result.js';
import { RunReconciliation } from './run-reconciliation.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('ledger integrity check', () => {
  it('reports an unbalanced transaction and drifting balances, and nothing on a clean tenant', async () => {
    const settlement = new FakeSettlement();
    const build = () =>
      new RunReconciliation({
        uow: h.uow,
        settlement,
        applyPayment: new ApplyPaymentResult({
          uow: h.uow,
          clock: h.clock,
          ids: h.ids,
          log: silentLogger,
        }),
        clock: h.clock,
        ids: h.ids,
        log: silentLogger,
        options: { autofix: true, maxItems: 1000 },
      });

    const cleanDay = startDay(h);
    const topup = await seedSucceededTopup(h, { amount: 60000 });
    settlement.set(cleanDay, [chargeFor(topup)]);
    const clean = await build().execute({ tenant: h.acme, day: cleanDay, triggeredBy: 'MANUAL' });
    expect(clean).toMatchObject({ status: 'COMPLETED', itemCount: 0 });

    const walletId = (
      await h.db
        .withSchema('t_acme')
        .selectFrom('accounts')
        .select('id')
        .where('customer_id', '=', topup.customer)
        .executeTakeFirstOrThrow()
    ).id;
    await tamperLedger(h, walletId);

    const badDay = startDay(h);
    settlement.set(badDay, [chargeFor(topup)]);
    const result = await build().execute({ tenant: h.acme, day: badDay, triggeredBy: 'MANUAL' });

    expect(result).toMatchObject({ status: 'COMPLETED', itemCount: 3 });
    const items = await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.listItems({ runId: result!.id, caseStatus: null, afterSeq: 0, limit: 10 }),
    );
    expect(items.map((i) => i.kind)).toEqual([
      'LEDGER_UNBALANCED',
      'BALANCE_MISMATCH',
      'BALANCE_MISMATCH',
    ]);
    expect(items[0]).toMatchObject({
      chargeId: null,
      topupId: null,
      detail: { transactionId: 'tx_bad', total: 7 },
    });
    const drift = Object.fromEntries(
      items.slice(1).map((i) => [(i.detail as { accountId: string }).accountId, i.detail]),
    );
    expect(drift[walletId]).toEqual({ accountId: walletId, balance: 60005, ledgerTotal: 60000 });
    expect(drift['system:MERCHANT:VND']).toEqual({
      accountId: 'system:MERCHANT:VND',
      balance: 0,
      ledgerTotal: 7,
    });
    expect(items.every((i) => i.caseStatus === 'OPEN' && i.action === 'NONE')).toBe(true);
  });
});
