import { RequestTopup } from '../../../services/wallet/src/application/request-topup.js';
import { CustomerId } from '../../../services/wallet/src/domain/customer-id.js';
import type { TenantId } from '../../../services/wallet/src/domain/tenant-id.js';
import type { PerfEnv } from './perf-env.js';

export interface SeededCustomer {
  tenant: TenantId;
  customerId: string;
}

export interface SeededTopup {
  tenant: TenantId;
  topupId: string;
  chargeId: string;
  amount: number;
}

const DEFAULT_CONCURRENCY = 16;

/** Số thứ tự khách đã cấp trên mỗi môi trường, để hai lần seed liên tiếp không trùng id (và không nạp đôi). */
const issued = new WeakMap<PerfEnv, number>();

/** Chạy `work(i)` cho i = 0..count-1 với tối đa `concurrency` việc cùng lúc; lỗi đầu tiên dừng việc nhận thêm và được ném ra. */
async function forEachLimited(
  count: number,
  concurrency: number,
  work: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= count) return;
      try {
        await work(index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), count) }, worker);
  const results = await Promise.allSettled(workers);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (rejected) throw rejected.reason;
}

/**
 * Tạo `count` ví (CreateWallet) rồi nạp `balance` bằng AdjustWallet CREDIT (đúng use case: bút toán kép đối ứng tài khoản
 * ADJUSTMENT, có ghi ops_actions), trải đều quanh các tenant. Không đi đường tắt SQL để bất biến sổ cái luôn do use case giữ.
 */
export async function seedCustomers(
  env: PerfEnv,
  input: { count: number; balance: number; currency?: string; concurrency?: number },
): Promise<SeededCustomer[]> {
  const currency = input.currency ?? 'VND';
  const start = issued.get(env) ?? 0;
  issued.set(env, start + input.count);
  const customers: SeededCustomer[] = Array.from({ length: input.count }, (_, i) => ({
    tenant: env.tenants[(start + i) % env.tenants.length]!,
    customerId: `perf-c${start + i}`,
  }));
  await forEachLimited(input.count, input.concurrency ?? DEFAULT_CONCURRENCY, async (i) => {
    const { tenant, customerId } = customers[i]!;
    await env.createWallet.execute({ tenant, customerId: CustomerId.parse(customerId), currency });
    await env.adjust.execute({
      tenant,
      customerId,
      direction: 'CREDIT',
      amount: input.balance,
      currency,
      actor: 'perf-seed',
      reason: 'perf seeding balance',
      idempotencyKey: `seed-fund-${tenant.value}-${customerId}`,
    });
  });
  return customers;
}

/**
 * Tạo `count` lần nạp bằng RequestTopup rồi đưa sang PENDING có `charge_id` (như SubmitTopup làm khi gateway nhận charge;
 * cùng cách với `seedTopup` trong services/wallet/src/test-support.ts). Mỗi topup dùng một lần trong kịch bản nạp tiền.
 */
export async function seedPendingTopups(
  env: PerfEnv,
  input: { count: number; customers: SeededCustomer[]; amount: number; concurrency?: number },
): Promise<SeededTopup[]> {
  if (input.customers.length === 0) throw new Error('seedPendingTopups cần ít nhất một khách');
  const requestTopup = new RequestTopup({
    uow: env.uow,
    clock: env.clock,
    ids: env.ids,
    // Không gửi sang payment: perf chỉ đo luồng áp kết quả, nên bộ gửi nền là no-op.
    submitter: { submitSoon: () => undefined },
  });
  const start = issued.get(env) ?? 0;
  issued.set(env, start + input.count);
  const topups: SeededTopup[] = new Array<SeededTopup>(input.count);
  await forEachLimited(input.count, input.concurrency ?? DEFAULT_CONCURRENCY, async (i) => {
    const customer = input.customers[i % input.customers.length]!;
    const { body } = await requestTopup.execute({
      tenant: customer.tenant,
      customerId: CustomerId.parse(customer.customerId),
      idempotencyKey: `seed-topup-${start + i}`,
      amount: input.amount,
    });
    const chargeId = `ch_${body.topupId}`;
    await env.uow.run(customer.tenant, async ({ topups: repository }) => {
      const topup = await repository.lockById(body.topupId);
      if (!topup) throw new Error(`seeded topup ${body.topupId} disappeared`);
      await repository.save(topup.recordSubmitted(chargeId));
    });
    topups[i] = { tenant: customer.tenant, topupId: body.topupId, chargeId, amount: input.amount };
  });
  return topups;
}
