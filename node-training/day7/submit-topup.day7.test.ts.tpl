// Bài 5 (Nâng cao) — test đơn vị cho SubmitTopup (services/wallet/src/application/submit-topup.ts) bằng đối tượng GIẢ.
// Sao chép file này thành services/wallet/src/application/submit-topup.day7.test.ts (bỏ đuôi .tpl).
// "Thế giới giả" đã dựng sẵn bên dưới: uow giả giữ MỘT topup trong bộ nhớ, gateway giả trả kết quả bạn chọn,
// đồng hồ giả bạn tự chỉnh. Việc của bạn: viết các test ở cuối file.
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

  // TODO 1: payment từ chối ({ kind: 'rejected', status: 422, message: 'no' }) -> 'REJECTED', topup FAILED/PAYMENT_REJECTED.
  it.todo('payment từ chối');

  // TODO 2: payment không sẵn sàng với backoff [1]: lần 1 -> 'RETRY_SCHEDULED' (topup vẫn REQUESTED, attempts 1);
  //         gọi lại ngay -> 'NOT_DUE' (chưa tới giờ, vì lease 60 giây); chỉnh đồng hồ tới hạn rồi gọi -> 'FAILED' (PAYMENT_UNAVAILABLE).
  it.todo('payment không sẵn sàng: hẹn lại rồi bỏ cuộc');

  // TODO 3: topup đã PENDING (dựng bằng Topup.rehydrate({ ...world.topup(), status: 'PENDING', chargeId: 'ch_0', nextAttemptAt: null }) rồi world.forceTopup(...)) thì executeFor trả 'NOT_DUE' và gateway KHÔNG được gọi.
  it.todo('topup không còn REQUESTED thì không gọi payment');

  it('XÓA SAU KHI XONG: bạn đã viết đủ 3 test', () => {
    throw new Error('chưa viết test');
  });
});
