import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidReconciliationError } from '../domain/errors.js';
import { previousDay } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import {
  createHarness,
  expectLedgerInvariants,
  seedTopup,
  silentLogger,
  type Harness,
} from '../test-support.js';
import {
  FakeSettlement,
  chargeFor,
  seedSucceededTopup,
  startDay,
} from '../test-support-reconciliation.js';
import { ApplyPaymentResult, type ApplyOutcome } from './apply-payment-result.js';
import { SettlementUnavailableError } from './errors.js';
import type { Logger } from './ports.js';
import { RunReconciliation, type RunReconciliationDeps } from './run-reconciliation.js';

let h: Harness;
let settlement: FakeSettlement;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  settlement = new FakeSettlement();
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

/** Logger ghi lại mọi dòng log để test kiểm tra. */
function recordingLogger(): Logger & {
  lines: Array<{ level: string; details: object; message?: string }>;
} {
  const lines: Array<{ level: string; details: object; message?: string }> = [];
  const at =
    (level: string) =>
    (details: object, message?: string): void => {
      lines.push(message === undefined ? { level, details } : { level, details, message });
    };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

function build(
  options: Partial<RunReconciliationDeps['options']> = {},
  applyPayment?: RunReconciliationDeps['applyPayment'],
  log: Logger = silentLogger,
): RunReconciliation {
  return new RunReconciliation({
    uow: h.uow,
    settlement,
    applyPayment:
      applyPayment ??
      new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger }),
    clock: h.clock,
    ids: h.ids,
    log,
    options: { autofix: true, maxItems: 1000, ...options },
  });
}

const itemsOf = (tenant: TenantId, runId: string) =>
  h.uow.run(tenant, ({ reconciliation }) =>
    reconciliation.listItems({ runId, caseStatus: null, afterSeq: 0, limit: 100 }),
  );
const walletBalance = async (tenant: TenantId, customer: string): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema(`t_${tenant.value}`)
        .selectFrom('accounts')
        .select('balance')
        .where('customer_id', '=', customer)
        .where('kind', '=', 'WALLET')
        .executeTakeFirstOrThrow()
    ).balance,
  );
const topupStatus = async (tenant: TenantId, topupId: string): Promise<string> =>
  (
    await h.db
      .withSchema(`t_${tenant.value}`)
      .selectFrom('topups')
      .select('status')
      .where('id', '=', topupId)
      .executeTakeFirstOrThrow()
  ).status;
const ledgerCount = async (tenant: TenantId, topupId: string): Promise<number> =>
  (
    await h.db
      .withSchema(`t_${tenant.value}`)
      .selectFrom('ledger_transactions')
      .select('id')
      .where('business_key', '=', `topup:${topupId}`)
      .execute()
  ).length;

const run = (day: string, tenant = h.acme, reconciliation = build()) =>
  reconciliation.execute({ tenant, day, triggeredBy: 'MANUAL' });

describe('a clean day', () => {
  it('completes with no items and stores informational totals', async () => {
    const day = startDay(h);
    const a = await seedSucceededTopup(h, { amount: 100000 });
    const b = await seedSucceededTopup(h, { amount: 50000 });
    settlement.set(day, [chargeFor(a), chargeFor(b)]);

    const result = await run(day);

    expect(result).toMatchObject({
      day,
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      itemCount: 0,
      gatewayTotals: { VND: 150000 },
      walletTotals: { VND: 150000 },
    });
    expect(settlement.calls).toEqual([day, previousDay(day)]);
    expect(await itemsOf(h.acme, result!.id)).toEqual([]);
  });
});

describe('MISSING_AT_WALLET (lost webhook)', () => {
  it('credits the wallet once, through the normal topup path, and records an AUTO_APPLIED item', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);

    const result = await run(day);

    const items = await itemsOf(h.acme, result!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'MISSING_AT_WALLET',
      action: 'AUTO_APPLIED',
      caseStatus: 'RESOLVED',
      resolvedBy: 'system',
      topupId: topup.topupId,
      chargeId: topup.chargeId,
      amountGateway: 90000,
      amountWallet: 90000,
      currency: 'VND',
    });
    expect(await walletBalance(h.acme, topup.customer)).toBe(90000);
    expect(await topupStatus(h.acme, topup.topupId)).toBe('SUCCEEDED');
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);
  });

  it('also credits a topup that was never submitted (REQUESTED) and one that FAILED as PAYMENT_UNAVAILABLE', async () => {
    const day = startDay(h);
    const requested = await seedTopup(h, { state: 'REQUESTED', amount: 10000 });
    const unavailable = await seedTopup(h, { state: 'FAILED_UNAVAILABLE', amount: 20000 });
    settlement.set(day, [
      chargeFor(requested, { chargeId: 'ch_gateway_only_1' }),
      chargeFor(unavailable, { chargeId: 'ch_gateway_only_2' }),
    ]);

    const result = await run(day);

    expect((await itemsOf(h.acme, result!.id)).map((i) => [i.kind, i.action])).toEqual([
      ['MISSING_AT_WALLET', 'AUTO_APPLIED'],
      ['MISSING_AT_WALLET', 'AUTO_APPLIED'],
    ]);
    expect(await walletBalance(h.acme, requested.customer)).toBe(10000);
    expect(await walletBalance(h.acme, unavailable.customer)).toBe(20000);
  });

  it('only reports when RECONCILE_AUTOFIX is off', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);

    const result = await run(day, h.acme, build({ autofix: false }));

    const items = await itemsOf(h.acme, result!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: 'NONE', caseStatus: 'OPEN', resolvedBy: null });
    expect(await walletBalance(h.acme, topup.customer)).toBe(0);
    expect(await topupStatus(h.acme, topup.topupId)).toBe('PENDING');
  });

  it('keeps a failed auto-credit as an open FAILED_AUTOFIX case', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);

    const result = await run(
      day,
      h.acme,
      build(
        {},
        {
          execute: () => {
            throw new Error('database exploded');
          },
        },
      ),
    );

    expect(result?.status).toBe('COMPLETED');
    const [item] = await itemsOf(h.acme, result!.id);
    expect(item).toMatchObject({
      action: 'FAILED_AUTOFIX',
      caseStatus: 'OPEN',
      detail: { autofix: 'error', error: 'database exploded' },
    });
  });

  it('credits exactly once when two runs race on the same day', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 70000 });
    settlement.set(day, [chargeFor(topup)]);

    const [first, second] = await Promise.all([run(day), run(day)]);

    expect(first?.status).toBe('COMPLETED');
    expect(second?.status).toBe('COMPLETED');
    expect(await walletBalance(h.acme, topup.customer)).toBe(70000);
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);
    // Lượt đến sau có thể thấy lần nạp đã SUCCEEDED (không có dòng lệch) hoặc còn PENDING (ghi bù trượt vì webhook/lượt kia đã ghi trước).
    const actions = [
      ...(await itemsOf(h.acme, first!.id)),
      ...(await itemsOf(h.acme, second!.id)),
    ].map((i) => i.action);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.every((action) => action === 'AUTO_APPLIED')).toBe(true);
  });
});

describe('a run that fails after crediting', () => {
  it('names the credited topup in the failure reason and never credits twice', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 55000 });
    settlement.set(day, [chargeFor(topup)]);
    // Bọc uow: completeRun bị lỗi sau khi lần ghi bù đã commit.
    const failing: RunReconciliationDeps['uow'] = {
      run: (tenant, work) =>
        h.uow.run(tenant, (repositories) =>
          work({
            ...repositories,
            // Kế thừa prototype để giữ nguyên các phương thức của repository thật.
            reconciliation: Object.assign(Object.create(repositories.reconciliation), {
              completeRun: () => Promise.reject(new Error('connection lost')),
            }),
          }),
        ),
    };
    const failingRun = new RunReconciliation({
      uow: failing,
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

    const result = await run(day, h.acme, failingRun);

    expect(result?.status).toBe('FAILED');
    expect(result?.failureReason).toContain('connection lost');
    expect(result?.failureReason).toContain(topup.topupId);
    expect(await walletBalance(h.acme, topup.customer)).toBe(55000);
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);

    const next = await run(day);
    expect(next?.status).toBe('COMPLETED');
    expect(await walletBalance(h.acme, topup.customer)).toBe(55000);
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);
  });
});

describe('a webhook that arrives in the middle of a run', () => {
  const real = () =>
    new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });

  it('is treated as already settled: credited exactly once, item AUTO_APPLIED', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 65000 });
    settlement.set(day, [chargeFor(topup)]);
    const implementation = real();
    const racing: RunReconciliationDeps['applyPayment'] = {
      execute: async (input) => {
        // Webhook thật đến ngay trước lệnh ghi bù của đối soát.
        const webhook = await implementation.execute({
          tenant: input.tenant,
          eventId: 'evt_webhook_race',
          type: 'charge.succeeded',
          chargeId: topup.chargeId,
          reference: topup.topupId,
          amount: topup.amount,
          currency: topup.currency,
        });
        expect(webhook).toBe('APPLIED');
        return implementation.execute(input);
      },
    };

    const result = await run(day, h.acme, build({}, racing));

    expect(result?.status).toBe('COMPLETED');
    const items = await itemsOf(h.acme, result!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'MISSING_AT_WALLET',
      action: 'AUTO_APPLIED',
      detail: { autofix: 'already settled' },
    });
    expect(await walletBalance(h.acme, topup.customer)).toBe(65000);
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);
  });

  it('does not claim a credit in the logs for the already-settled item', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 12000 });
    settlement.set(day, [chargeFor(topup)]);
    const log = recordingLogger();
    const implementation = real();
    await run(
      day,
      h.acme,
      build(
        {},
        {
          execute: async (input) => {
            await implementation.execute({ ...input, eventId: 'evt_webhook_race_2' });
            return implementation.execute(input);
          },
        },
        log,
      ),
    );
    const messages = log.lines.map((line) => line.message);
    expect(messages).toContain('reconciliation auto-applied item recorded');
    expect(messages).not.toContain('reconciliation credited a topup whose webhook was lost');
  });
});

describe('autofix outcomes that cannot be credited', () => {
  const stub = (outcome: ApplyOutcome): RunReconciliationDeps['applyPayment'] => ({
    execute: () => Promise.resolve(outcome),
  });

  it.each<ApplyOutcome>(['IGNORED', 'MISMATCH', 'DUPLICATE', 'UNKNOWN_TOPUP'])(
    'keeps %s as an open FAILED_AUTOFIX case (topup is not SUCCEEDED)',
    async (outcome) => {
      const day = startDay(h);
      const topup = await seedTopup(h, { state: 'PENDING', amount: 33000 });
      settlement.set(day, [chargeFor(topup)]);

      const result = await run(day, h.acme, build({}, stub(outcome)));

      const [item] = await itemsOf(h.acme, result!.id);
      expect(item).toMatchObject({
        action: 'FAILED_AUTOFIX',
        caseStatus: 'OPEN',
        detail: { autofix: outcome },
      });
      expect(await walletBalance(h.acme, topup.customer)).toBe(0);
    },
  );
});

describe('a run closed by the stale sweep while it was still working', () => {
  it('stores no items, credits once, and logs the credited topup at error level', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 44000 });
    settlement.set(day, [chargeFor(topup)]);
    const log = recordingLogger();
    const reconciliation = build({}, undefined, log);
    const handle = await reconciliation.begin({ tenant: h.acme, day, triggeredBy: 'MANUAL' });
    // Bộ quét đóng lượt "bỏ dở" trước khi `finish` kịp hoàn tất.
    const swept = await h.uow.run(h.acme, ({ reconciliation: repo }) =>
      repo.failStaleRuns(new Date(h.clock.now().getTime() + 60_000), 'abandoned', h.clock.now()),
    );
    expect(swept).toBeGreaterThanOrEqual(1);

    const result = await reconciliation.finish(handle!);

    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'abandoned', itemCount: 0 });
    expect(await itemsOf(h.acme, handle!.runId)).toEqual([]);
    expect(await walletBalance(h.acme, topup.customer)).toBe(44000);
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);
    const credited = log.lines.find(
      (line) =>
        line.level === 'error' &&
        JSON.stringify(line.details).includes(topup.topupId) &&
        line.message?.includes('already closed'),
    );
    expect(credited).toBeDefined();
  });
});

describe('discrepancies that need a human', () => {
  it('reports UNKNOWN_CHARGE, AMOUNT_MISMATCH and STATUS_MISMATCH without touching the ledger', async () => {
    const day = startDay(h);
    const wrongAmount = await seedTopup(h, { state: 'PENDING', amount: 30000 });
    const ghostCharge = {
      chargeId: 'ch_ghost',
      reference: 'tp_ghost',
      amount: 5000,
      currency: 'VND',
      status: 'SUCCEEDED',
      tenantId: 'acme',
    } as const;
    const settled = await seedSucceededTopup(h, { amount: 40000 });
    settlement.set(day, [
      chargeFor(wrongAmount, { amount: 31000 }),
      ghostCharge,
      chargeFor(settled, { status: 'FAILED' }),
    ]);

    const result = await run(day);

    const items = await itemsOf(h.acme, result!.id);
    expect(items.map((i) => [i.kind, i.caseStatus, i.action])).toEqual([
      ['AMOUNT_MISMATCH', 'OPEN', 'NONE'],
      ['UNKNOWN_CHARGE', 'OPEN', 'NONE'],
      ['STATUS_MISMATCH', 'OPEN', 'NONE'],
    ]);
    expect(items[0]).toMatchObject({ amountGateway: 31000, amountWallet: 30000 });
    expect(items[1]).toMatchObject({ chargeId: 'ch_ghost', topupId: null });
    expect(await walletBalance(h.acme, wrongAmount.customer)).toBe(0);
    expect(await walletBalance(h.acme, settled.customer)).toBe(40000);
  });

  it('reports MISSING_AT_GATEWAY unless the gateway listed the charge on the previous day', async () => {
    const day = startDay(h);
    const lost = await seedSucceededTopup(h);
    const early = await seedSucceededTopup(h);
    settlement.set(previousDay(day), [chargeFor(early)]);

    const result = await run(day);

    const items = await itemsOf(h.acme, result!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'MISSING_AT_GATEWAY',
      topupId: lost.topupId,
      amountGateway: null,
      amountWallet: lost.amount,
      detail: {
        walletStatus: 'SUCCEEDED',
        topupCreatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        topupCompletedAt: h.clock.now().toISOString(),
      },
    });
  });

  it('ignores charges that belong to another tenant or carry no tenant', async () => {
    const day = startDay(h);
    const topup = await seedSucceededTopup(h, { tenant: h.beta });
    settlement.set(day, [
      chargeFor(topup),
      {
        chargeId: 'ch_anon',
        reference: 'tp_anon',
        amount: 1,
        currency: 'VND',
        status: 'SUCCEEDED',
        tenantId: null,
      },
    ]);

    const acme = await run(day, h.acme);
    const beta = await run(day, h.beta);

    expect(acme).toMatchObject({ status: 'COMPLETED', itemCount: 0, gatewayTotals: {} });
    expect(beta).toMatchObject({
      status: 'COMPLETED',
      itemCount: 0,
      gatewayTotals: { VND: topup.amount },
    });
  });
});

describe('failures', () => {
  it('fails the run, creates no items and credits nothing when the gateway is unavailable', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);
    settlement.failWith = new SettlementUnavailableError('gateway down');

    const result = await run(day);

    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'gateway down', itemCount: 0 });
    expect(result?.finishedAt).not.toBeNull();
    expect(await itemsOf(h.acme, result!.id)).toEqual([]);
    expect(await walletBalance(h.acme, topup.customer)).toBe(0);
  });

  it('fails the run when the settlement has more charges than RECONCILE_MAX_ITEMS', async () => {
    const day = startDay(h);
    const a = await seedSucceededTopup(h);
    const b = await seedSucceededTopup(h);
    settlement.set(day, [chargeFor(a), chargeFor(b)]);

    const result = await run(day, h.acme, build({ maxItems: 1 }));

    expect(result?.status).toBe('FAILED');
    expect(result?.failureReason).toMatch(/more than 1 charges/);
  });

  it('fails the run when there are more discrepancies than RECONCILE_MAX_ITEMS', async () => {
    const day = startDay(h);
    await seedSucceededTopup(h);
    await seedSucceededTopup(h);

    const result = await run(day, h.acme, build({ maxItems: 1 }));

    expect(result?.status).toBe('FAILED');
    expect(result?.failureReason).toMatch(/2 discrepancies/);
  });
});

describe('runs', () => {
  it('are immutable: a re-run creates a new run and leaves the old items alone', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 25000 });
    settlement.set(day, [chargeFor(topup)]);

    const first = await run(day);
    const before = await itemsOf(h.acme, first!.id);
    const second = await run(day);

    expect(second?.id).not.toBe(first?.id);
    expect(await itemsOf(h.acme, first!.id)).toEqual(before);
    expect(await itemsOf(h.acme, second!.id)).toEqual([]);
    expect(
      await h.uow.run(h.acme, ({ reconciliation }) => reconciliation.findRun(first!.id)),
    ).toMatchObject({
      status: 'COMPLETED',
      itemCount: 1,
    });
  });

  it('rejects a malformed, impossible or future day', async () => {
    const day = startDay(h);
    const tomorrow = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const bad of [tomorrow, '2027-02-30', 'yesterday']) {
      await expect(
        build().begin({ tenant: h.acme, day: bad, triggeredBy: 'MANUAL' }),
      ).rejects.toBeInstanceOf(InvalidReconciliationError);
    }
  });

  it('refuses a second SCHEDULED run for the same day (begin returns null)', async () => {
    const day = startDay(h);
    const reconciliation = build();
    expect(
      await reconciliation.begin({ tenant: h.acme, day, triggeredBy: 'SCHEDULED' }),
    ).not.toBeNull();
    expect(
      await reconciliation.begin({ tenant: h.acme, day, triggeredBy: 'SCHEDULED' }),
    ).toBeNull();
    expect(
      await reconciliation.begin({ tenant: h.acme, day, triggeredBy: 'MANUAL' }),
    ).not.toBeNull();
  });
});
