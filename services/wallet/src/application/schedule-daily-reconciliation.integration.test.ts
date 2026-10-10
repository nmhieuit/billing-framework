import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, silentLogger, type Harness } from '../test-support.js';
import { FakeSettlement } from '../test-support-reconciliation.js';
import { ApplyPaymentResult } from './apply-payment-result.js';
import { SettlementUnavailableError } from './errors.js';
import { RunReconciliation } from './run-reconciliation.js';
import {
  ScheduleDailyReconciliation,
  RETRY_AFTER_MINUTES,
} from './schedule-daily-reconciliation.js';

let h: Harness;
let settlement: FakeSettlement;
let dayCounter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  settlement = new FakeSettlement();
});

/** Mỗi test một ngày riêng; trả về ngày "hôm qua" mà bộ lập lịch sẽ đối soát. */
function today(hour = 3): { now: string; yesterday: string } {
  const base = Date.UTC(2028, 0, 10 + ++dayCounter);
  const now = new Date(base + hour * 3_600_000).toISOString();
  h.clock.set(now);
  return { now, yesterday: new Date(base - 86_400_000).toISOString().slice(0, 10) };
}

function build(options = { atUtcHour: 2, maxAttempts: 2 }) {
  const run = new RunReconciliation({
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
  return new ScheduleDailyReconciliation({
    uow: h.uow,
    run,
    clock: h.clock,
    log: silentLogger,
    options,
  });
}

const runsFor = (day: string) =>
  h.db
    .withSchema('t_acme')
    .selectFrom('reconciliation_runs')
    .selectAll()
    .where('run_day', '=', day)
    .orderBy('started_at')
    .execute();

describe('ScheduleDailyReconciliation', () => {
  it('waits until RECONCILE_AT_UTC_HOUR', async () => {
    const { yesterday } = today(1);
    expect(await build().execute(h.acme)).toBe('TOO_EARLY');
    expect(settlement.calls).toEqual([]);
    expect(await runsFor(yesterday)).toEqual([]);
  });

  it('reconciles yesterday once, even after a restart', async () => {
    const { yesterday } = today(3);
    const scheduler = build();

    expect(await scheduler.execute(h.acme)).toBe('RAN');
    const calls = settlement.calls.length;
    expect(settlement.calls[0]).toBe(yesterday);
    expect(await runsFor(yesterday)).toMatchObject([
      { triggered_by: 'SCHEDULED', status: 'COMPLETED' },
    ]);

    expect(await scheduler.execute(h.acme)).toBe('DONE');
    expect(await build().execute(h.acme)).toBe('DONE');
    expect(settlement.calls).toHaveLength(calls);
    expect(await runsFor(yesterday)).toHaveLength(1);
  });

  it('retries a failed run no sooner than 15 minutes later and gives up after RECONCILE_MAX_ATTEMPTS', async () => {
    const { yesterday } = today(3);
    const scheduler = build({ atUtcHour: 2, maxAttempts: 2 });
    settlement.failWith = new SettlementUnavailableError('gateway down');

    expect(await scheduler.execute(h.acme)).toBe('RAN');
    expect(await scheduler.execute(h.acme)).toBe('WAITING');

    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    expect(await scheduler.execute(h.acme)).toBe('RAN');

    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    settlement.failWith = undefined;
    expect(await scheduler.execute(h.acme)).toBe('GAVE_UP');
    expect(await scheduler.execute(h.acme)).toBe('GAVE_UP');
    expect((await runsFor(yesterday)).map((r) => r.status)).toEqual(['FAILED', 'FAILED']);
  });

  it('recovers when the gateway comes back before the attempts run out', async () => {
    const { yesterday } = today(3);
    const scheduler = build({ atUtcHour: 2, maxAttempts: 3 });
    settlement.failWith = new SettlementUnavailableError('gateway down');
    expect(await scheduler.execute(h.acme)).toBe('RAN');

    settlement.failWith = undefined;
    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    expect(await scheduler.execute(h.acme)).toBe('RAN');
    expect(await scheduler.execute(h.acme)).toBe('DONE');
    expect((await runsFor(yesterday)).map((r) => r.status)).toEqual(['FAILED', 'COMPLETED']);
  });

  it('abandons a RUNNING run left behind by a crashed worker, then retries after the wait', async () => {
    const { yesterday } = today(3);
    await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.startRun({
        id: 'crashed',
        day: yesterday,
        triggeredBy: 'SCHEDULED',
        startedAt: new Date(h.clock.now().getTime() - 31 * 60_000),
      }),
    );
    const scheduler = build();

    expect(await scheduler.execute(h.acme)).toBe('WAITING');
    expect((await runsFor(yesterday))[0]).toMatchObject({
      id: 'crashed',
      status: 'FAILED',
    });
    expect((await runsFor(yesterday))[0]?.failure_reason).toMatch(/abandoned/);

    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    expect(await scheduler.execute(h.acme)).toBe('RAN');
  });

  it('leaves a fresh RUNNING run to the worker that owns it', async () => {
    const { yesterday } = today(3);
    await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.startRun({
        id: 'live',
        day: yesterday,
        triggeredBy: 'SCHEDULED',
        startedAt: h.clock.now(),
      }),
    );
    expect(await build().execute(h.acme)).toBe('IN_PROGRESS');
    expect(settlement.calls).toEqual([]);
  });

  it('starts only one run when two workers tick at the same time', async () => {
    const { yesterday } = today(3);
    const outcomes = await Promise.all([build().execute(h.acme), build().execute(h.acme)]);

    expect(outcomes.filter((o) => o === 'RAN')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== 'RAN')[0]).toMatch(/^(SKIPPED|IN_PROGRESS|DONE)$/);
    expect(await runsFor(yesterday)).toHaveLength(1);
  });

  it('treats tenants independently', async () => {
    const { yesterday } = today(3);
    const scheduler = build();
    expect(await scheduler.execute(h.acme)).toBe('RAN');
    expect(await scheduler.execute(h.beta)).toBe('RAN');
    const beta = await h.db
      .withSchema('t_beta')
      .selectFrom('reconciliation_runs')
      .select('status')
      .where('run_day', '=', yesterday)
      .execute();
    expect(beta).toEqual([{ status: 'COMPLETED' }]);
  });
});
