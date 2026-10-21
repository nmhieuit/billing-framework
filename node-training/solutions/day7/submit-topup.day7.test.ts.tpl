import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { TenantId } from '../domain/tenant-id.js';
import { Topup } from '../domain/topup.js';
import type { GatewayChargeResult, Logger } from './ports.js';
import { SubmitTopup } from './submit-topup.js';

const tenant = TenantId.parse('acme');
const t0 = new Date('2026-10-10T10:00:00.000Z');

function makeWorld(results: GatewayChargeResult[], backoffSeconds: number[]) {
  let current = Topup.request({
    id: 'tp_1',
    customerId: CustomerId.parse('c1'),
    accountId: 'wallet:c1',
    amount: Money.of(1500, 'VND'),
    now: t0,
  });
  let now = t0;
  let calls = 0;
  const logs: string[] = [];
  const log: Logger = {
    info: () => undefined,
    warn: (_details, message) => void logs.push(`warn: ${message}`),
    error: (_details, message) => void logs.push(`error: ${message}`),
  };
  const submit = new SubmitTopup({
    uow: {
      async run(_tenant: TenantId, work: (repositories: never) => Promise<unknown>) {
        return work({
          topups: {
            async lockById() {
              return current;
            },
            async lockNextDue(at: Date) {
              return current.isDue(at) ? current : null;
            },
            async save(topup: Topup) {
              current = topup;
            },
          },
        } as never);
      },
    } as never,
    gateway: {
      async createCharge() {
        const result = results[Math.min(calls, results.length - 1)] as GatewayChargeResult;
        calls += 1;
        return result;
      },
    },
    clock: { now: () => now },
    log,
    backoffSeconds,
  });
  return {
    submit,
    topup: () => current.toProps(),
    logs,
    calls: () => calls,
    setNow: (date: Date) => void (now = date),
    forceTopup: (topup: Topup) => void (current = topup),
  };
}

describe('SubmitTopup.executeFor', () => {
  it('ví dụ mẫu: payment nhận -> SUBMITTED và topup PENDING', async () => {
    const world = makeWorld([{ kind: 'created', chargeId: 'ch_1' }], [1, 5]);
    expect(await world.submit.executeFor(tenant, 'tp_1')).toBe('SUBMITTED');
    expect(world.topup()).toMatchObject({ status: 'PENDING', chargeId: 'ch_1', attempts: 1 });
  });

  it('payment từ chối', async () => {
    const world = makeWorld([{ kind: 'rejected', status: 422, message: 'no' }], [1, 5]);
    expect(await world.submit.executeFor(tenant, 'tp_1')).toBe('REJECTED');
    expect(world.topup()).toMatchObject({ status: 'FAILED', failureCode: 'PAYMENT_REJECTED' });
    expect(world.logs).toEqual(['error: topup rejected by payment; marked FAILED (PAYMENT_REJECTED)']);
  });

  it('payment không sẵn sàng: hẹn lại rồi bỏ cuộc', async () => {
    const world = makeWorld([{ kind: 'unavailable', error: 'HTTP 503' }], [1]);

    expect(await world.submit.executeFor(tenant, 'tp_1')).toBe('RETRY_SCHEDULED');
    expect(world.topup()).toMatchObject({ status: 'REQUESTED', attempts: 1 });
    expect(world.topup().nextAttemptAt).toEqual(new Date(t0.getTime() + 1000));

    world.setNow(new Date(t0.getTime() + 500));
    expect(await world.submit.executeFor(tenant, 'tp_1')).toBe('NOT_DUE');
    expect(world.calls()).toBe(1);

    world.setNow(new Date(t0.getTime() + 1000));
    expect(await world.submit.executeFor(tenant, 'tp_1')).toBe('FAILED');
    expect(world.topup()).toMatchObject({ status: 'FAILED', failureCode: 'PAYMENT_UNAVAILABLE', attempts: 2 });
  });

  it('topup không còn REQUESTED thì không gọi payment', async () => {
    const world = makeWorld([{ kind: 'created', chargeId: 'ch_9' }], [1]);
    const pending = Topup.rehydrate({ ...world.topup(), status: 'PENDING', chargeId: 'ch_0', nextAttemptAt: null });
    world.forceTopup(pending);
    expect(await world.submit.executeFor(tenant, 'tp_1')).toBe('NOT_DUE');
    expect(world.calls()).toBe(0);
  });
});
