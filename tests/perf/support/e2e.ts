import { randomUUID } from 'node:crypto';
import { assertSystemInvariants } from '../../chaos/support/invariants.js';
import { createSystem, type System } from '../../chaos/support/system-harness.js';
import { summarizeLatencies } from './histogram.js';
import type { E2eResult } from './report.js';
import { readSqlServerVersion } from './runner.js';

export interface E2eOptions {
  orders: number;
  concurrency: number;
}

const TENANT = 'perf1';
/** Mỗi đơn 1 000 VND (như kịch bản use case). */
const E2E_ORDER_AMOUNT = 1_000;
/** Tối đa số ví nhận đơn xoay vòng. */
const MAX_WALLETS = 20;
/** Một đơn quá hạn này mà chưa có kết quả thì coi là kẹt (đo vô hiệu). */
const ORDER_TIMEOUT_MS = 60_000;
const HEAL_TIMEOUT_MS = 180_000;

type Verdict = { kind: 'PAID' | 'FAILED'; at: number };

/**
 * Đo đầu-cuối: wallet + payment + broker THẬT chạy trong tiến trình (createSystem, không tiêm lỗi). Nạp tiền ví qua API thật
 * (POST /topups → payment → webhook), gửi `orders` đơn qua broker bằng `concurrency` luồng gửi kín (mỗi luồng gửi một đơn, chờ
 * OrderPaidV1 của chính đơn đó rồi mới gửi đơn tiếp). Độ trễ mỗi đơn = từ lúc bắt đầu gửi tới lúc Orders giả nhận OrderPaidV1,
 * thông lượng = số đơn / thời gian cả lô. Sau đó heal() và assertSystemInvariants(): vi phạm → ném lỗi.
 * Thời điểm nhận được ghi ngay khi kết quả được đẩy vào mảng của Orders giả (không thăm dò).
 */
export async function runE2e(
  options: E2eOptions,
): Promise<{ result: E2eResult; sqlServerVersion: string | null }> {
  const system = await createSystem({ tenants: [TENANT] });
  try {
    const sqlServerVersion = await readSqlServerVersion(system.walletAdmin);
    const customers = await fundWallets(system, options.orders);

    const waiting = new Map<string, (verdict: Verdict) => void>();
    // Đo thời điểm nhận ngay lúc consumer của Orders giả đẩy kết quả vào mảng (bọc push của CHÍNH mảng này, chỉ trong code test),
    // nên không bị lượng tử hóa bởi chu kỳ thăm dò/timer của Windows. Khớp đơn theo orderId qua Map `waiting`.
    const results = system.orders.results;
    const originalPush = results.push;
    results.push = function (this: typeof results, ...items: typeof results): number {
      const at = performance.now();
      const length = originalPush.apply(this, items);
      for (const message of items) {
        const orderId = message.body.orderId;
        const resolve = typeof orderId === 'string' ? waiting.get(orderId) : undefined;
        if (resolve === undefined) continue;
        waiting.delete(orderId as string);
        resolve({ kind: message.type === 'OrderPaidV1' ? 'PAID' : 'FAILED', at });
      }
      return length;
    };
    const restorePush = (): void => {
      // Gỡ bản bọc (thuộc tính riêng của mảng) để mảng trở lại push nguyên bản của Array.prototype.
      delete (results as { push?: unknown }).push;
    };

    const latencies: number[] = [];
    let failed = 0;
    let next = 0;
    const sender = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= options.orders) return;
        const orderId = randomUUID();
        let timer: NodeJS.Timeout | undefined;
        const verdict = new Promise<Verdict>((resolve, reject) => {
          waiting.set(orderId, resolve);
          timer = setTimeout(() => {
            waiting.delete(orderId);
            reject(new Error(`đơn ${orderId} không có kết quả sau ${ORDER_TIMEOUT_MS} ms`));
          }, ORDER_TIMEOUT_MS);
        });
        verdict.catch(() => undefined); // tránh unhandled rejection nếu sendOrder ném trước
        try {
          const started = performance.now();
          await system.sendOrder({
            tenant: TENANT,
            customer: customers[index % customers.length]!,
            orderId,
            amount: E2E_ORDER_AMOUNT,
          });
          const done = await verdict;
          if (done.kind === 'PAID') latencies.push(done.at - started);
          else failed += 1;
        } finally {
          clearTimeout(timer);
          waiting.delete(orderId);
        }
      }
    };

    const batchStart = performance.now();
    let wallMs: number;
    try {
      await Promise.all(Array.from({ length: options.concurrency }, () => sender()));
      wallMs = performance.now() - batchStart;
    } finally {
      restorePush();
    }
    if (failed > 0) {
      throw new Error(
        `e2e vô hiệu: ${failed}/${options.orders} đơn bị từ chối (OrderPaymentFailedV1)`,
      );
    }

    await system.heal({ timeoutMs: HEAL_TIMEOUT_MS });
    await assertSystemInvariants(system); // ném InvariantViolationError nếu vi phạm

    const summary = summarizeLatencies(latencies);
    return {
      result: {
        orders: options.orders,
        concurrency: options.concurrency,
        throughputPerSec: options.orders / (wallMs / 1000),
        p50Ms: summary.p50,
        p95Ms: summary.p95,
        p99Ms: summary.p99,
        invariantsOk: true,
      },
      sqlServerVersion,
    };
  } finally {
    await system.stop();
  }
}

/** Mở ví và nạp tiền qua API thật, chờ hội tụ (heal) trước khi đo; thời gian này NẰM NGOÀI cửa sổ đo. */
async function fundWallets(system: System, orders: number): Promise<string[]> {
  const count = Math.min(orders, MAX_WALLETS);
  const perWallet = Math.ceil(orders / count);
  const amount = Math.max(1_000_000, perWallet * E2E_ORDER_AMOUNT * 2);
  const customers = Array.from({ length: count }, (_, i) => `e2e-c${i}`);
  for (const [i, customer] of customers.entries()) {
    const opened = await system.openWallet(TENANT, customer);
    if (opened.status !== 201) throw new Error(`openWallet ${customer} trả ${opened.status}`);
    const topup = await system.topup(TENANT, customer, amount, `e2e-topup-${i}`);
    if (topup.status !== 202) throw new Error(`topup ${customer} trả ${topup.status}`);
  }
  await system.heal({ timeoutMs: HEAL_TIMEOUT_MS });
  return customers;
}
