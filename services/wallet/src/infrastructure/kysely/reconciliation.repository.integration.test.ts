import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import type { NewReconciliationItem, ReconciliationRepository } from '../../application/ports.js';
import {
  createHarness,
  expectLedgerInvariants,
  seedTopup,
  silentLogger,
  type Harness,
} from '../../test-support.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.000Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const item = (
  id: string,
  overrides: Partial<NewReconciliationItem> = {},
): NewReconciliationItem => ({
  id,
  kind: 'MISSING_AT_WALLET',
  chargeId: `ch_${id}`,
  topupId: `tp_${id}`,
  amountGateway: 1000,
  amountWallet: 1000,
  currency: 'VND',
  detail: { note: id },
  action: 'NONE',
  ...overrides,
});
const repo = <T>(work: (r: ReconciliationRepository) => Promise<T>) =>
  h.uow.run(h.acme, ({ reconciliation }) => work(reconciliation));

describe('runs', () => {
  it('starts a run, completes it with items, and reads it back', async () => {
    expect(
      await repo((r) =>
        r.startRun({ id: 'run-a', day: '2026-09-01', triggeredBy: 'MANUAL', startedAt: t0 }),
      ),
    ).toBe(true);
    await repo((r) =>
      r.completeRun('run-a', {
        gatewayTotals: { VND: 3000 },
        walletTotals: { VND: 2000, USD: 5 },
        items: [
          item('a1'),
          item('a2', { action: 'AUTO_APPLIED' }),
          item('a3', {
            kind: 'LEDGER_UNBALANCED',
            chargeId: null,
            topupId: null,
            amountGateway: null,
            amountWallet: null,
            currency: null,
          }),
        ],
        finishedAt: at(1),
      }),
    );
    const run = await repo((r) => r.findRun('run-a'));
    expect(run).toMatchObject({
      id: 'run-a',
      day: '2026-09-01',
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      failureReason: null,
      gatewayTotals: { VND: 3000 },
      walletTotals: { VND: 2000, USD: 5 },
      itemCount: 3,
    });
    expect(run?.finishedAt).toEqual(at(1));
    expect(await repo((r) => r.findRun('missing'))).toBeNull();
  });

  it('stores auto-applied items as RESOLVED by system and the rest as OPEN, paged by seq', async () => {
    const first = await repo((r) =>
      r.listItems({ runId: 'run-a', caseStatus: null, afterSeq: 0, limit: 2 }),
    );
    expect(first.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(first[0]).toMatchObject({
      caseStatus: 'OPEN',
      resolvedBy: null,
      detail: { note: 'a1' },
      amountGateway: 1000,
    });
    expect(first[1]).toMatchObject({
      caseStatus: 'RESOLVED',
      resolvedBy: 'system',
      resolutionNote: 'auto-applied by reconciliation',
      action: 'AUTO_APPLIED',
    });
    const second = await repo((r) =>
      r.listItems({ runId: 'run-a', caseStatus: null, afterSeq: first[1]!.seq, limit: 10 }),
    );
    expect(second.map((i) => i.id)).toEqual(['a3']);
    expect(second[0]).toMatchObject({
      kind: 'LEDGER_UNBALANCED',
      chargeId: null,
      amountGateway: null,
      currency: null,
    });
    const open = await repo((r) =>
      r.listItems({ runId: 'run-a', caseStatus: 'OPEN', afterSeq: 0, limit: 10 }),
    );
    expect(open.map((i) => i.id)).toEqual(['a1', 'a3']);
  });

  it('allows a second SCHEDULED start only after the first one failed', async () => {
    const start = (id: string) =>
      repo((r) => r.startRun({ id, day: '2026-09-02', triggeredBy: 'SCHEDULED', startedAt: t0 }));
    expect(await start('s1')).toBe(true);
    expect(await start('s2')).toBe(false);
    await repo((r) => r.failRun('s1', 'gateway down', at(5)));
    expect(await repo((r) => r.findRun('s1'))).toMatchObject({
      status: 'FAILED',
      failureReason: 'gateway down',
    });
    expect(await start('s3')).toBe(true);
    expect(await repo((r) => r.scheduledRunsFor('2026-09-02'))).toEqual({
      running: 1,
      completed: 0,
      failed: 1,
      lastFailedAt: at(5),
    });
    expect(await repo((r) => r.scheduledRunsFor('2026-01-01'))).toEqual({
      running: 0,
      completed: 0,
      failed: 0,
      lastFailedAt: null,
    });
  });

  it('fails only RUNNING runs older than the cutoff', async () => {
    await repo((r) =>
      r.startRun({ id: 'old', day: '2026-09-03', triggeredBy: 'MANUAL', startedAt: at(-60) }),
    );
    await repo((r) =>
      r.startRun({ id: 'new', day: '2026-09-03', triggeredBy: 'MANUAL', startedAt: at(-1) }),
    );
    expect(await repo((r) => r.failStaleRuns(at(-30), 'abandoned', t0))).toBe(1);
    expect(await repo((r) => r.findRun('old'))).toMatchObject({
      status: 'FAILED',
      failureReason: 'abandoned',
    });
    expect(await repo((r) => r.findRun('new'))).toMatchObject({ status: 'RUNNING' });
  });
});

describe('items', () => {
  it('resolves an open item once and refuses to touch a closed one', async () => {
    const locked = await h.uow.run(h.acme, async ({ reconciliation }) => {
      const found = await reconciliation.lockItem('a1');
      await reconciliation.resolveItem('a1', {
        status: 'RESOLVED',
        resolvedBy: 'ops-1',
        note: 'checked',
        at: at(2),
      });
      return found;
    });
    expect(locked).toMatchObject({ id: 'a1', caseStatus: 'OPEN' });
    const after = await repo((r) => r.lockItem('a1'));
    expect(after).toMatchObject({
      caseStatus: 'RESOLVED',
      resolvedBy: 'ops-1',
      resolutionNote: 'checked',
    });
    expect(after?.resolvedAt).toEqual(at(2));
    await repo((r) =>
      r.resolveItem('a1', { status: 'IGNORED', resolvedBy: 'ops-2', note: 'again', at: at(3) }),
    );
    expect(await repo((r) => r.lockItem('a1'))).toMatchObject({
      caseStatus: 'RESOLVED',
      resolvedBy: 'ops-1',
    });
    expect(await repo((r) => r.lockItem('nope'))).toBeNull();
  });
});

describe('wallet-side reads', () => {
  it('finds topups by id (more than one chunk) and lists succeeded ones by completion time', async () => {
    const pending = await seedTopup(h, { state: 'PENDING', amount: 5000 });
    const settled = await seedTopup(h, { state: 'PENDING', amount: 7000 });
    h.clock.set('2026-08-15T10:00:00.000Z');
    await new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
    }).execute({
      tenant: h.acme,
      eventId: 'evt_repo_1',
      type: 'charge.succeeded',
      chargeId: settled.chargeId,
      reference: settled.topupId,
      amount: settled.amount,
      currency: settled.currency,
    });

    const ids = [
      pending.topupId,
      settled.topupId,
      ...Array.from({ length: 700 }, (_, i) => `nope_${i}`),
    ];
    const found = await repo((r) => r.findTopupsByIds(ids));
    expect(found.map((t) => t.id).sort()).toEqual([pending.topupId, settled.topupId].sort());
    expect(found.find((t) => t.id === settled.topupId)).toEqual({
      id: settled.topupId,
      chargeId: settled.chargeId,
      amount: 7000,
      currency: 'VND',
      status: 'SUCCEEDED',
      failureCode: null,
    });
    expect(await repo((r) => r.findTopupsByIds([]))).toEqual([]);

    const between = (from: string, to: string) =>
      repo((r) => r.listSucceededTopups(new Date(from), new Date(to)));
    expect(
      (await between('2026-08-15T00:00:00.000Z', '2026-08-16T00:00:00.000Z')).map((t) => t.id),
    ).toEqual([settled.topupId]);
    expect(await between('2026-08-16T00:00:00.000Z', '2026-08-17T00:00:00.000Z')).toEqual([]);
    expect(await between('2026-08-14T00:00:00.000Z', '2026-08-15T10:00:00.000Z')).toEqual([]);
  });

  it('reports no ledger problems on a consistent tenant', async () => {
    expect(await repo((r) => r.findUnbalancedTransactions())).toEqual([]);
    expect(await repo((r) => r.findBalanceMismatches())).toEqual([]);
    await expectLedgerInvariants(h, h.acme);
  });
});
