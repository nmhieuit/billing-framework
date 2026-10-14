import { randomUUID } from 'node:crypto';
import type { DriverResult } from './load-driver.js';
import type { PerfEnv } from './perf-env.js';
import {
  CURRENCY,
  type PreparedScenario,
  type ScenarioDefinition,
  type ScenarioPlan,
} from './runner.js';
import { seedPendingTopups, type SeededCustomer, type SeededTopup } from './seed.js';
import type { LedgerCounts } from './validity.js';

/** Mỗi lệnh trả order là 1 000 VND (nhỏ cố định, số dư khách đủ lớn nên không bao giờ thiếu tiền). */
export const ORDER_AMOUNT = 1_000;
export const TOPUP_AMOUNT = 10_000;
export const ADJUST_AMOUNT = 1_000;

// Tỷ lệ của kịch bản mixed.
const PAY_SHARE = 0.7;
const TOPUP_SHARE = 0.15;
const ADJUST_SHARE = 0.1; // 5% còn lại là đảo giao dịch.
/** Dư 20% cho dao động ngẫu nhiên của tỷ lệ 15% khi cấp phát hàng đợi topup cho mixed. */
const TOPUP_QUEUE_SLACK = 1.2;

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

// Số thao tác thành công THỰC TẾ, đếm mọi thao tác đã commit (cả lúc khởi động nóng và lúc xả).
// Sổ cái chứa tất cả, còn DriverResult.ok chỉ đếm trong cửa sổ đo nên không dùng để đối chiếu.
interface Tally {
  paid: number;
  applied: number;
  adjusted: number;
  reversed: number;
  /** Số lần mixed rơi vào nhánh đảo nhưng chưa có giao dịch để đảo nên trả order thay (đã nằm trong paid). */
  fallbackPays: number;
}

const newTally = (): Tally => ({ paid: 0, applied: 0, adjusted: 0, reversed: 0, fallbackPays: 0 });

/** Một dòng ghi chú về số thao tác THỰC TẾ, để người đọc kiểm tra tỷ lệ 70/15/10/5 của mixed. */
function tallyNote(tally: Tally): string {
  const total = tally.paid + tally.applied + tally.adjusted + tally.reversed;
  const share = (n: number): string => (total === 0 ? 'n/a' : `${((n / total) * 100).toFixed(1)}%`);
  return `thao tác thực tế (cả khởi động và xả): trả order ${tally.paid} (${share(tally.paid)}, trong đó ${tally.fallbackPays} trả thay cho đảo), nạp ${tally.applied} (${share(tally.applied)}), điều chỉnh ${tally.adjusted} (${share(tally.adjusted)}), đảo ${tally.reversed} (${share(tally.reversed)})`;
}

/** Trả một order mới; chỉ PAID là thành công, REJECTED/REPLAYED/DUPLICATE là lỗi 'other'. Trả id giao dịch ví. */
async function payOnce(
  env: PerfEnv,
  customers: readonly SeededCustomer[],
  tally: Tally,
): Promise<{ tenant: SeededCustomer['tenant']; transactionId: string }> {
  const customer = pick(customers);
  const outcome = await env.payOrder.execute({
    tenant: customer.tenant,
    eventId: randomUUID(),
    correlationId: randomUUID(),
    orderId: randomUUID(),
    customerId: customer.customerId,
    amount: ORDER_AMOUNT,
    currency: CURRENCY,
  });
  if (outcome.kind !== 'PAID') {
    throw new Error(
      `PayOrder trả ${outcome.kind}${outcome.kind === 'REJECTED' ? ` (${outcome.reason})` : ''}, mong đợi PAID`,
    );
  }
  tally.paid += 1;
  return { tenant: customer.tenant, transactionId: outcome.walletTransactionId };
}

/** Hàng đợi topup PENDING dùng một lần; cạn thì ghi nhận và ném lỗi rõ ràng (không bao giờ quay vòng). */
class TopupQueue {
  private next = 0;
  exhausted = false;

  /** `sizing`: mô tả quy tắc cấp phát (cận tĩnh estimateMaxOps), mức đồng thời, lần lặp, để lỗi cạn tự giải thích. */
  constructor(
    private readonly topups: readonly SeededTopup[],
    private readonly sizing: string,
  ) {}

  exhaustedProblem(): string {
    return `hàng đợi topup cạn giữa lượt đo, kết quả đo không đầy đủ (${this.sizing})`;
  }

  remaining(): number {
    return this.topups.length - this.next;
  }

  take(): SeededTopup {
    const topup = this.topups[this.next];
    if (topup === undefined) {
      this.exhausted = true;
      throw new Error(
        `hàng đợi topup đã cạn sau ${this.topups.length} lần áp (${this.sizing}): tăng PER_WORKER_OPS_PER_SEC/TOTAL_OPS_PER_SEC trong runner.ts`,
      );
    }
    this.next += 1;
    return topup;
  }
}

const sizingOf = (plan: ScenarioPlan, count: number): string =>
  `quy tắc: cận tĩnh estimateMaxOps = ${plan.maxOps} thao tác, hàng đợi ${count}; mức đồng thời ${plan.concurrency}, lần lặp ${plan.repeat}`;

/** Số topup còn lại chưa dùng: PENDING tích lũy trong DB qua các lần lặp (vô hại cho checkLedger và cho phép đo). */
const unusedNote = (queue: TopupQueue): string =>
  `${queue.remaining()} topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)`;

async function applyOnce(env: PerfEnv, queue: TopupQueue, tally: Tally): Promise<void> {
  const topup = queue.take();
  const outcome = await env.applyPayment.execute({
    tenant: topup.tenant,
    eventId: randomUUID(), // MỖI lần áp một eventId mới (inbox chống trùng theo eventId)
    type: 'charge.succeeded',
    chargeId: topup.chargeId,
    reference: topup.topupId,
    amount: topup.amount,
    currency: topup.currency,
  });
  if (outcome !== 'APPLIED') throw new Error(`ApplyPaymentResult trả ${outcome}, mong đợi APPLIED`);
  tally.applied += 1;
}

const delta = (before: number, after: number): number => after - before;

function expectEqual(problems: string[], what: string, actual: number, expected: number): void {
  if (actual !== expected)
    problems.push(`${what}: sổ cái tăng ${actual}, thao tác thành công ${expected}`);
}

/** Kịch bản không điều chỉnh/đảo thì các loại đó phải không tăng. */
function checkNone(
  problems: string[],
  before: LedgerCounts,
  after: LedgerCounts,
  kinds: Array<'topup' | 'reversal' | 'adjustment' | 'orderPayment'>,
): void {
  if (kinds.includes('topup')) {
    expectEqual(
      problems,
      'giao dịch TOPUP',
      delta(before.topupTransactions, after.topupTransactions),
      0,
    );
  }
  if (kinds.includes('reversal')) {
    expectEqual(
      problems,
      'giao dịch REVERSAL',
      delta(before.reversalTransactions, after.reversalTransactions),
      0,
    );
  }
  if (kinds.includes('adjustment')) {
    expectEqual(
      problems,
      'giao dịch ADJUSTMENT',
      delta(before.adjustmentTransactions, after.adjustmentTransactions),
      0,
    );
  }
  if (kinds.includes('orderPayment')) {
    expectEqual(
      problems,
      'giao dịch ORDER_PAYMENT',
      delta(before.orderPaymentTransactions, after.orderPaymentTransactions),
      0,
    );
  }
}

function checkPayments(
  problems: string[],
  tally: Tally,
  before: LedgerCounts,
  after: LedgerCounts,
): void {
  expectEqual(
    problems,
    'order_payments',
    delta(before.orderPayments, after.orderPayments),
    tally.paid,
  );
  expectEqual(
    problems,
    'giao dịch ORDER_PAYMENT',
    delta(before.orderPaymentTransactions, after.orderPaymentTransactions),
    tally.paid,
  );
}

export const payOrderScenario: ScenarioDefinition = {
  name: 'pay-order',
  description:
    'Mỗi thao tác trả một order 1 000 VND cho một khách ngẫu nhiên: mọi lệnh cùng khóa tài khoản MERCHANT (điểm nóng).',
  prepare(env, _config, plan): Promise<PreparedScenario> {
    const tally = newTally();
    return Promise.resolve({
      task: async () => {
        await payOnce(env, plan.customers, tally);
      },
      verify(_result: DriverResult, before, after) {
        const problems: string[] = [];
        checkPayments(problems, tally, before, after);
        checkNone(problems, before, after, ['topup', 'reversal', 'adjustment']);
        return problems;
      },
    });
  },
};

export const topupApplyScenario: ScenarioDefinition = {
  name: 'topup-apply',
  description:
    'Mỗi thao tác áp kết quả charge.succeeded cho một topup PENDING chưa dùng (hàng đợi seed trước, ngoài cửa sổ đo).',
  async prepare(env, _config, plan): Promise<PreparedScenario> {
    // Seed ngoài cửa sổ đo: toàn bộ chi phí này nằm trong prepare().
    const topups = await seedPendingTopups(env, {
      count: plan.maxOps,
      customers: [...plan.customers],
      amount: TOPUP_AMOUNT,
    });
    const queue = new TopupQueue(topups, sizingOf(plan, topups.length));
    const tally = newTally();
    return {
      task: () => applyOnce(env, queue, tally),
      summary: () => unusedNote(queue),
      verify(_result, before, after) {
        const problems: string[] = [];
        if (queue.exhausted) problems.push(queue.exhaustedProblem());
        expectEqual(
          problems,
          'giao dịch TOPUP',
          delta(before.topupTransactions, after.topupTransactions),
          tally.applied,
        );
        checkNone(problems, before, after, ['orderPayment', 'reversal', 'adjustment']);
        return problems;
      },
    };
  },
};

export const mixedScenario: ScenarioDefinition = {
  name: 'mixed',
  description:
    'Hỗn hợp: 70% trả order, 15% áp nạp tiền, 10% điều chỉnh CREDIT ví, 5% đảo một giao dịch ORDER_PAYMENT đã tạo trong lượt (chưa có thì trả order thay).',
  async prepare(env, _config, plan): Promise<PreparedScenario> {
    const topups = await seedPendingTopups(env, {
      count: Math.ceil(plan.maxOps * TOPUP_SHARE * TOPUP_QUEUE_SLACK) + plan.concurrency,
      customers: [...plan.customers],
      amount: TOPUP_AMOUNT,
    });
    const queue = new TopupQueue(topups, sizingOf(plan, topups.length));
    const tally = newTally();
    // Giao dịch ORDER_PAYMENT vừa tạo và chưa bị đảo; lấy ra (pop) khi đảo để mỗi giao dịch chỉ bị đảo một lần.
    const reversible: Array<{ tenant: SeededCustomer['tenant']; transactionId: string }> = [];
    return {
      summary: () => `${tallyNote(tally)}; ${unusedNote(queue)}`,
      task: async () => {
        const roll = Math.random();
        if (roll < PAY_SHARE) {
          reversible.push(await payOnce(env, plan.customers, tally));
        } else if (roll < PAY_SHARE + TOPUP_SHARE) {
          await applyOnce(env, queue, tally);
        } else if (roll < PAY_SHARE + TOPUP_SHARE + ADJUST_SHARE) {
          const customer = pick(plan.customers);
          await env.adjust.execute({
            tenant: customer.tenant,
            customerId: customer.customerId,
            direction: 'CREDIT',
            amount: ADJUST_AMOUNT,
            currency: CURRENCY,
            actor: 'perf-mixed',
            reason: 'perf mixed adjustment',
            idempotencyKey: randomUUID(),
          });
          tally.adjusted += 1;
        } else {
          const target = reversible.pop();
          if (target === undefined) {
            // Chưa có giao dịch nào để đảo: trả order thay (vẫn là một thao tác thật, không phải thao tác rỗng).
            reversible.push(await payOnce(env, plan.customers, tally));
            tally.fallbackPays += 1;
            return;
          }
          await env.reverse.execute({
            tenant: target.tenant,
            transactionId: target.transactionId,
            actor: 'perf-mixed',
            reason: 'perf mixed reversal',
            idempotencyKey: randomUUID(),
          });
          tally.reversed += 1;
        }
      },
      verify(_result, before, after) {
        const problems: string[] = [];
        if (queue.exhausted) problems.push(queue.exhaustedProblem());
        checkPayments(problems, tally, before, after);
        expectEqual(
          problems,
          'giao dịch TOPUP',
          delta(before.topupTransactions, after.topupTransactions),
          tally.applied,
        );
        expectEqual(
          problems,
          'giao dịch REVERSAL',
          delta(before.reversalTransactions, after.reversalTransactions),
          tally.reversed,
        );
        expectEqual(
          problems,
          'giao dịch ADJUSTMENT',
          delta(before.adjustmentTransactions, after.adjustmentTransactions),
          tally.adjusted,
        );
        return problems;
      },
    };
  },
};

export const SCENARIOS: readonly ScenarioDefinition[] = [
  payOrderScenario,
  topupApplyScenario,
  mixedScenario,
];
