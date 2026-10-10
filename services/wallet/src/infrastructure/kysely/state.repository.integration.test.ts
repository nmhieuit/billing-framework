import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewOutboxMessage, NewReconciliationItem } from '../../application/ports.js';
import { createHarness, seedTopup, type Harness } from '../../test-support.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.000Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const snapshot = (tenant = h.acme) => h.uow.run(tenant, ({ state }) => state.snapshot());

const outboxMessage = (id: string, createdAt: Date): NewOutboxMessage => ({
  id,
  eventType: 'wallet.order-paid',
  routingKey: 'wallet.order-paid',
  payload: '{}',
  correlationId: `corr-${id}`,
  createdAt,
});
const item = (id: string, kind: NewReconciliationItem['kind']): NewReconciliationItem => ({
  id,
  kind,
  chargeId: `ch_${id}`,
  topupId: `tp_${id}`,
  amountGateway: 1000,
  amountWallet: 1000,
  currency: 'VND',
  detail: {},
  action: 'NONE',
});

const EMPTY = {
  outboxPending: 0,
  outboxOldestCreatedAt: null,
  topupsRequested: 0,
  topupsOldestCreatedAt: null,
  openItemsByKind: {},
  oldestOpenItemCreatedAt: null,
  lastReconciliationSuccessAt: null,
};

// Các test dùng chung dữ liệu của acme theo thứ tự; beta luôn để trống để kiểm tra cô lập tenant.
describe('KyselyStateRepository', () => {
  it('reports zeros and nulls for a tenant with nothing in flight', async () => {
    expect(await snapshot()).toEqual(EMPTY);
  });

  it('counts PENDING outbox rows and reports the oldest one', async () => {
    await h.uow.run(h.acme, async ({ outbox }) => {
      await outbox.add(outboxMessage('ob-new', at(5)));
      await outbox.add(outboxMessage('ob-old', at(1)));
      await outbox.add(outboxMessage('ob-sent', at(0)));
      await outbox.markSent('ob-sent', at(2));
    });
    const s = await snapshot();
    expect(s.outboxPending).toBe(2);
    expect(s.outboxOldestCreatedAt).toEqual(at(1));
  });

  it('counts REQUESTED topups only, with the oldest created_at', async () => {
    h.clock.set(at(3));
    await seedTopup(h, { state: 'REQUESTED' });
    h.clock.set(at(7));
    await seedTopup(h, { state: 'REQUESTED' });
    h.clock.set(at(1));
    await seedTopup(h, { state: 'PENDING' });
    h.clock.set(t0);
    const s = await snapshot();
    expect(s.topupsRequested).toBe(2);
    expect(s.topupsOldestCreatedAt).toEqual(at(3));
  });

  it('groups OPEN reconciliation items by kind and ignores RESOLVED and IGNORED ones', async () => {
    await h.uow.run(h.acme, async ({ reconciliation }) => {
      await reconciliation.startRun({
        id: 'run-1',
        day: '2026-10-01',
        triggeredBy: 'MANUAL',
        startedAt: at(0),
      });
      await reconciliation.completeRun('run-1', {
        gatewayTotals: {},
        walletTotals: {},
        items: [
          item('i1', 'MISSING_AT_WALLET'),
          item('i2', 'MISSING_AT_WALLET'),
          item('i3', 'AMOUNT_MISMATCH'),
          item('i4', 'UNKNOWN_CHARGE'),
          item('i5', 'UNKNOWN_CHARGE'),
          { ...item('i6', 'MISSING_AT_WALLET'), action: 'AUTO_APPLIED' },
        ],
        finishedAt: at(10),
      });
      await reconciliation.resolveItem('i4', {
        status: 'RESOLVED',
        resolvedBy: 'ops',
        note: 'ok',
        at: at(11),
      });
      await reconciliation.resolveItem('i5', {
        status: 'IGNORED',
        resolvedBy: 'ops',
        note: 'skip',
        at: at(11),
      });
    });
    const s = await snapshot();
    expect(s.openItemsByKind).toEqual({ MISSING_AT_WALLET: 2, AMOUNT_MISMATCH: 1 });
    expect(s.oldestOpenItemCreatedAt).toEqual(at(10));
  });

  it('takes the last reconciliation success from the newest COMPLETED run only', async () => {
    await h.uow.run(h.acme, async ({ reconciliation }) => {
      await reconciliation.startRun({
        id: 'run-2',
        day: '2026-10-02',
        triggeredBy: 'MANUAL',
        startedAt: at(20),
      });
      await reconciliation.completeRun('run-2', {
        gatewayTotals: {},
        walletTotals: {},
        items: [],
        finishedAt: at(21),
      });
      await reconciliation.startRun({
        id: 'run-3',
        day: '2026-10-03',
        triggeredBy: 'MANUAL',
        startedAt: at(30),
      });
      await reconciliation.failRun('run-3', 'boom', at(31));
      await reconciliation.startRun({
        id: 'run-4',
        day: '2026-10-04',
        triggeredBy: 'MANUAL',
        startedAt: at(40),
      });
    });
    expect((await snapshot()).lastReconciliationSuccessAt).toEqual(at(21));
  });

  it('keeps tenants apart', async () => {
    expect(await snapshot(h.beta)).toEqual(EMPTY);
  });
});
