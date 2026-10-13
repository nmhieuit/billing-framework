import { sql } from 'kysely';
import {
  assertSystemInvariants,
  collectViolations,
  explainedByMissingAtWallet,
  isMissingAtWallet,
  RECONCILE_TIMEOUT_MS,
  runReconciliationViaHttp,
} from './invariants.js';
import { createPrng, type Prng } from './prng.js';
import { killSessions } from './sql-faults.js';
import { adminQuery, createSystem, type ChildSystem, type System } from './system-harness.js';

/**
 * Bộ sinh tải và lịch lỗi của bài SOAK.
 *
 * TÁI HIỆN (nói thật về mức độ): cùng seed cho cùng KẾ HOẠCH, tức (a) chuỗi lựa chọn thao tác của từng luồng (mỗi luồng một
 * prng fork riêng, mỗi lần chọn tiêu thụ đúng số lần rút cố định) và (b) lịch lỗi theo thời gian (prng fork riêng). Phần
 * THỰC THI thì không tất định: thứ tự đan xen giữa các luồng, thời điểm một request tới đích, kết quả của rule xác suất
 * (prng của FaultPlan được tiêu thụ theo thứ tự các câu SQL thực tế) đều phụ thuộc lịch hệ điều hành và SQL Server. Vì vậy
 * chạy lại theo seed cho cùng kịch bản tải/lỗi nhưng không đảm bảo cùng lỗi xảy ra; nhật ký thao tác ghi lại điều ĐÃ xảy ra.
 */

export const SOAK_WORKERS = 8;
export const SOAK_TENANTS = ['acme', 'beta'] as const;
const CUSTOMERS_PER_TENANT = 4;
const FUND = 1_000_000;
// Phải >= thời gian chờ tối đa của một lượt đối soát gọi tay: nếu luồng bỏ cuộc sớm hơn thì lượt đối soát vẫn chạy nền và
// có thể ghi bù SAU khi vòng kết thúc (xem heal() về lượt RUNNING).
const OP_TIMEOUT_MS = RECONCILE_TIMEOUT_MS + 15_000;

export type OpKind =
  | 'topup'
  | 'order'
  | 'adjust'
  | 'opsRepeat'
  | 'reverse'
  | 'freeze'
  | 'unfreeze'
  | 'replayPaid'
  | 'read'
  | 'reconcile'
  | 'agePurge';

const OP_WEIGHTS: ReadonlyArray<readonly [OpKind, number]> = [
  ['topup', 20],
  ['order', 25],
  ['adjust', 10],
  ['opsRepeat', 5],
  ['reverse', 6],
  ['freeze', 4],
  ['unfreeze', 4],
  ['replayPaid', 5],
  ['read', 12],
  ['reconcile', 2],
  ['agePurge', 4],
];

/** Một lần chọn thao tác. Mọi trường được rút ra từ prng với SỐ LẦN RÚT CỐ ĐỊNH (không phụ thuộc kind). */
export interface OpPlan {
  kind: OpKind;
  /** Số thực [0,1) dùng để chọn đích trong danh sách mục tiêu hiện có lúc chạy. */
  u1: number;
  u2: number;
  u3: number;
  amount: number;
  pauseMs: number;
}

export function drawOp(prng: Prng): OpPlan {
  const total = OP_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let r = prng.next() * total;
  let kind: OpKind = 'read';
  for (const [k, w] of OP_WEIGHTS) {
    if (r < w) {
      kind = k;
      break;
    }
    r -= w;
  }
  return {
    kind,
    u1: prng.next(),
    u2: prng.next(),
    u3: prng.next(),
    amount: prng.int(100, 20_000),
    pauseMs: prng.int(150, 600),
  };
}

/** Kế hoạch `count` lựa chọn đầu tiên của luồng `worker` (thuần, dùng cho meta-test). */
export function planWorkerOps(prng: Prng, worker: number, count: number): OpPlan[] {
  const stream = prng.fork(`worker-${worker}`);
  return Array.from({ length: count }, () => drawOp(stream));
}

export type FaultKind =
  | 'sql-kill-rule'
  | 'sql-kill-now'
  | 'publish-dup'
  | 'publish-loss'
  | 'broker-drop'
  | 'proxy-5xx'
  | 'proxy-slow'
  | 'proxy-drop'
  | 'webhook-drop'
  | 'webhook-dup'
  | 'webhook-5xx'
  | 'webhook-slow'
  | 'restart-wallet'
  | 'restart-payment'
  | 'crash-wallet'
  | 'crash-payment';

export interface FaultStep {
  atMs: number;
  kind: FaultKind;
  service: 'wallet' | 'payment';
  probability: number;
  times: number;
  ms: number;
}

const FAULTS: Record<'inproc' | 'child', ReadonlyArray<readonly [FaultKind, number]>> = {
  inproc: [
    ['sql-kill-rule', 4],
    ['sql-kill-now', 3],
    ['publish-dup', 3],
    ['publish-loss', 2],
    ['broker-drop', 3],
    ['proxy-5xx', 3],
    ['proxy-slow', 3],
    ['proxy-drop', 2],
    ['webhook-drop', 3],
    ['webhook-dup', 2],
    ['webhook-5xx', 2],
    ['webhook-slow', 1],
    ['restart-wallet', 1],
    ['restart-payment', 1],
  ],
  child: [
    ['sql-kill-now', 4],
    ['broker-drop', 3],
    ['proxy-5xx', 3],
    ['proxy-slow', 3],
    ['proxy-drop', 2],
    ['webhook-drop', 3],
    ['webhook-dup', 2],
    ['webhook-5xx', 2],
    ['crash-wallet', 2],
    ['crash-payment', 2],
  ],
};

/** Lỗi có thể làm webhook/charge mất hợp lệ (đường HTTP giữa hai dịch vụ hoặc dịch vụ ngừng): xem settleAndJudge. */
const WEBHOOK_AFFECTING: ReadonlySet<FaultKind> = new Set([
  'proxy-5xx',
  'proxy-slow',
  'proxy-drop',
  'webhook-drop',
  'webhook-5xx',
  'webhook-slow',
  'restart-wallet',
  'restart-payment',
  'crash-wallet',
  'crash-payment',
]);

/** Lịch lỗi theo thời gian (thuần). Mỗi bước rút đúng 5 số từ prng nên lịch ổn định theo seed. */
export function planFaults(prng: Prng, durationMs: number, mode: 'inproc' | 'child'): FaultStep[] {
  const stream = prng.fork('faults');
  const table = FAULTS[mode];
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  const steps: FaultStep[] = [];
  let at = stream.int(200, 900);
  while (at < durationMs) {
    let r = stream.next() * total;
    let kind: FaultKind = table[0]?.[0] ?? 'sql-kill-now';
    for (const [k, w] of table) {
      if (r < w) {
        kind = k;
        break;
      }
      r -= w;
    }
    steps.push({
      atMs: at,
      kind,
      service: stream.pick(['wallet', 'payment'] as const),
      probability: 0.1 + stream.next() * 0.4,
      times: stream.int(1, 3),
      ms: stream.int(200, 3500),
    });
    at += stream.int(400, 2500);
  }
  return steps;
}

export interface SoakReport {
  mode: 'inproc' | 'child';
  planned: FaultStep[];
  /** Các bước lỗi đã thực sự được thi hành (theo thứ tự lịch). */
  executed: FaultStep[];
  /** Số thao tác tải mỗi luồng đã BẮT ĐẦU, và số lần client nhận lỗi/quá hạn (không phải lỗi test). */
  opsStarted: number[];
  opErrors: number;
  /** Số thao tác trả 2xx theo loại: chứng minh từng loại tải thực sự chạy được (không bị bỏ qua lặng lẽ). */
  succeeded: Partial<Record<OpKind, number>>;
  /** Có lỗi nào thuộc nhóm làm webhook/charge mất hợp lệ không (quyết định độ chặt của INV-3 ở settleAndJudge). */
  webhookAffecting: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`quá hạn ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const isChargeCreation = (info: Record<string, unknown>): boolean =>
  info.method === 'POST' && typeof info.url === 'string' && info.url.includes('/charges');
const isWebhookPost = (info: Record<string, unknown>): boolean =>
  info.method === 'POST' && typeof info.url === 'string' && info.url.includes('/webhooks/payment');

const customerName = (index: number): string => `soak-c${index}`;

/** Mở ví và nạp tiền lớn cho các khách của soak (CHƯA có lỗi), chờ hội tụ rồi bật lại plan. */
async function setup(system: System): Promise<void> {
  for (const tenant of SOAK_TENANTS) {
    for (let c = 0; c < CUSTOMERS_PER_TENANT; c += 1) {
      const customer = customerName(c);
      await system.openWallet(tenant, customer);
      await system.topup(tenant, customer, FUND, `soak-fund-${tenant}-${customer}`);
    }
  }
  await system.heal();
  system.plan.enable();
}

async function applyFault(system: System, step: FaultStep, mode: 'inproc' | 'child') {
  const { plan } = system;
  const label = `soak-${step.kind}`;
  const db = step.service === 'wallet' ? system.walletDb : system.paymentDb;
  const base = { label, probability: step.probability, times: step.times };
  switch (step.kind) {
    case 'sql-kill-rule':
      plan.add({
        ...base,
        point: 'sql.query.before',
        when: (info) => info.name === step.service,
        action: async () => {
          await killSessions(db);
        },
      });
      return;
    case 'sql-kill-now':
      await killSessions(db);
      return;
    case 'publish-dup':
      plan.add({
        ...base,
        point: 'broker.publish.after',
        action: () => {
          throw new Error('mất ack sau publish (soak)');
        },
      });
      return;
    case 'publish-loss':
      plan.add({
        ...base,
        point: 'broker.publish.before',
        action: () => {
          throw new Error('publish thất bại (soak)');
        },
      });
      return;
    case 'broker-drop':
      await system.dropWalletBrokerConnections();
      return;
    case 'proxy-5xx':
      plan.add({
        ...base,
        point: 'wallet-to-payment.request',
        when: isChargeCreation,
        action: (info) => {
          info.decision = { status: 503 };
        },
      });
      return;
    case 'proxy-slow':
      plan.add({
        ...base,
        point: 'wallet-to-payment.request',
        when: isChargeCreation,
        action: (info) => {
          info.decision = { delayMs: step.ms };
        },
      });
      return;
    case 'proxy-drop':
      plan.add({
        ...base,
        point: 'wallet-to-payment.request',
        when: isChargeCreation,
        action: (info) => {
          info.decision = 'drop';
        },
      });
      return;
    case 'webhook-drop':
    case 'webhook-dup':
    case 'webhook-5xx':
    case 'webhook-slow':
      plan.add({
        ...base,
        point: 'payment-to-wallet.request',
        when: isWebhookPost,
        action: (info) => {
          info.decision =
            step.kind === 'webhook-drop'
              ? 'drop'
              : step.kind === 'webhook-dup'
                ? 'duplicate'
                : step.kind === 'webhook-5xx'
                  ? { status: 502 }
                  : { delayMs: step.ms };
        },
      });
      return;
    case 'restart-wallet':
      await system.restartWallet();
      return;
    case 'restart-payment':
      await system.restartPayment();
      return;
    case 'crash-wallet':
    case 'crash-payment': {
      if (mode !== 'child') throw new Error('crash chỉ có ở chế độ child');
      const child = system as ChildSystem;
      const wallet = step.kind === 'crash-wallet';
      await (wallet ? child.crashWallet() : child.crashPayment());
      await sleep(300 + step.ms / 2); // dịch vụ chết một lúc rồi mới dựng lại
      await (wallet ? child.restartWallet() : child.restartPayment());
      return;
    }
  }
}

interface Shared {
  reversible: Array<{ tenant: string; id: string }>;
  last: Map<number, { tenant: string; route: string; body: unknown }>;
}

const pickIndex = (u: number, length: number): number =>
  Math.min(length - 1, Math.floor(u * length));

async function runOp(system: System, plan: OpPlan, worker: number, i: number, shared: Shared) {
  const tenant = SOAK_TENANTS[pickIndex(plan.u1, SOAK_TENANTS.length)] as string;
  const customer = customerName(pickIndex(plan.u2, CUSTOMERS_PER_TENANT));
  const key = `soak-${worker}-${i}`;
  const body = { reason: `soak ${key}`, idempotencyKey: key };
  switch (plan.kind) {
    case 'topup':
      return (await system.topup(tenant, customer, plan.amount, key)).status;
    case 'order':
      await system.sendOrder({ tenant, customer, amount: 100 + (plan.amount % 3000) });
      return 202;
    case 'adjust': {
      const route = `/ops/wallets/${customer}/adjustments`;
      const request = {
        ...body,
        direction: plan.u3 < 0.7 ? 'CREDIT' : 'DEBIT',
        amount: 100 + (plan.amount % 2000),
        currency: 'VND',
      };
      shared.last.set(worker, { tenant, route, body: request });
      const result = await system.ops(tenant, route, request);
      const id = (result.body as { transactionId?: unknown } | undefined)?.transactionId;
      if (result.status === 201 && typeof id === 'string') shared.reversible.push({ tenant, id });
      return result.status;
    }
    case 'opsRepeat': {
      const last = shared.last.get(worker);
      if (last === undefined) return 0;
      return (await system.ops(last.tenant, last.route, last.body)).status;
    }
    case 'reverse': {
      const target = shared.reversible[pickIndex(plan.u3, Math.max(1, shared.reversible.length))];
      if (target === undefined) return 0;
      const route = `/ops/transactions/${target.id}/reversals`;
      shared.last.set(worker, { tenant: target.tenant, route, body });
      return (await system.ops(target.tenant, route, body)).status;
    }
    case 'freeze':
    case 'unfreeze': {
      const route = `/ops/wallets/${customer}/${plan.kind}`;
      shared.last.set(worker, { tenant, route, body });
      return (await system.ops(tenant, route, body)).status;
    }
    case 'replayPaid': {
      const found = await adminQuery(system.walletAdmin, (db) =>
        sql<{ order_id: string }>`
          select top (20) order_id from ${sql.id(`t_${tenant}`, 'order_payments')}
          order by paid_at desc`.execute(db),
      );
      const row = found.rows[pickIndex(plan.u3, Math.max(1, found.rows.length))];
      if (row === undefined) return 0;
      const route = `/ops/orders/${row.order_id}/replay-paid`;
      shared.last.set(worker, { tenant, route, body });
      return (await system.ops(tenant, route, body)).status;
    }
    case 'read': {
      const response = await fetch(`${system.walletUrl}/wallet`, {
        headers: { 'x-tenant-id': tenant, 'x-customer-id': customer },
        signal: AbortSignal.timeout(15_000),
      });
      await response.arrayBuffer();
      return response.status;
    }
    case 'reconcile': {
      const day = new Date().toISOString().slice(0, 10);
      return (await runReconciliationViaHttp(system, tenant, day, 1)).status === 'COMPLETED'
        ? 200
        : 500;
    }
    case 'agePurge': {
      // Chỉ khi retention thật được cấu hình: làm "già" vài dòng đã SENT để retention có việc giữa lúc tải.
      if (!system.retentionDeletes) return 0;
      const aged = sql`dateadd(day, -3, sysutcdatetime())`;
      const t = sql.id(`t_${tenant}`);
      await adminQuery(system.walletAdmin, (db) =>
        sql`update top (3) ${t}.outbox set sent_at = ${aged}
            where status = 'SENT' and sent_at > dateadd(day, -1, sysutcdatetime())`.execute(db),
      );
      await adminQuery(system.walletAdmin, (db) =>
        sql`update top (3) ${t}.processed_messages set processed_at = ${aged}
            where processed_at > dateadd(day, -1, sysutcdatetime())`.execute(db),
      );
      return 200;
    }
  }
}

/**
 * Một vòng soak: chuẩn bị ví, rồi trong `durationMs` chạy ~8 luồng tải song song cùng một luồng lịch lỗi. Mọi hành động
 * (tải lẫn lỗi) vào OpLog của hệ. Lỗi phía client do lỗi gài KHÔNG phải lỗi test; chỉ oracle sau heal() quyết định.
 * Chưa heal/oracle: gọi settleAndJudge().
 */
export async function runSoakRound(input: {
  system: System;
  prng: Prng;
  durationMs: number;
  mode: 'inproc' | 'child';
}): Promise<SoakReport> {
  const { system, prng, durationMs, mode } = input;
  await setup(system);
  const planned = planFaults(prng, durationMs, mode);
  const executed: FaultStep[] = [];
  const opsStarted = Array.from({ length: SOAK_WORKERS }, () => 0);
  let opErrors = 0;
  const succeeded: Partial<Record<OpKind, number>> = {};
  const shared: Shared = { reversible: [], last: new Map() };
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  system.log.record('soak.start', { mode, durationMs, planned: planned.length });

  const worker = async (index: number): Promise<void> => {
    const stream = prng.fork(`worker-${index}`);
    for (let i = 0; Date.now() < deadline; i += 1) {
      const plan = drawOp(stream);
      opsStarted[index] = i + 1;
      system.log.record('soak.op', { w: index, i, kind: plan.kind });
      try {
        const status = await withTimeout(runOp(system, plan, index, i, shared), OP_TIMEOUT_MS);
        if (status >= 400) opErrors += 1;
        if (status >= 200 && status < 300) succeeded[plan.kind] = (succeeded[plan.kind] ?? 0) + 1;
      } catch (error) {
        opErrors += 1;
        system.log.record('soak.op.error', {
          w: index,
          i,
          kind: plan.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(plan.pauseMs);
    }
  };

  const faults = async (): Promise<void> => {
    for (const [index, step] of planned.entries()) {
      const wait = startedAt + step.atMs - Date.now();
      if (wait > 0) await sleep(wait);
      if (Date.now() >= deadline) return;
      executed.push(step);
      system.log.record('soak.fault', { index, ...step });
      try {
        await applyFault(system, step, mode);
      } catch (error) {
        system.log.record('soak.fault.error', {
          index,
          kind: step.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  await Promise.all([faults(), ...Array.from({ length: SOAK_WORKERS }, (_, w) => worker(w))]);
  system.log.record('soak.end', { executed: executed.length, opErrors });
  return {
    mode,
    planned,
    executed,
    opsStarted,
    opErrors,
    succeeded,
    webhookAffecting: executed.some((s) => WEBHOOK_AFFECTING.has(s.kind)),
  };
}

/**
 * Sau vòng soak: ngừng tiêm lỗi (heal tắt plan, dựng lại dịch vụ chết) rồi để oracle quyết định.
 *
 * Độ chặt của INV-3: lỗi trên đường HTTP wallet↔payment hoặc dịch vụ ngừng (xem WEBHOOK_AFFECTING) có thể làm webhook hết
 * lượt gửi hoặc làm topup FAILED sau khi charge đã SUCCEEDED; đó là trạng thái MISSING_AT_WALLET mà đối soát sửa (S7). Ta KHÔNG
 * đoán trước: heal chờ mọi thứ hội tụ nhưng cho phép topup chưa chốt, rồi đọc INV-3 (chỉ đọc):
 *  - sạch                    → assertSystemInvariants CHẶT (không miễn trừ nào);
 *  - còn vi phạm, và (có lỗi thuộc nhóm trên VÀ chúng được MISSING_AT_WALLET giải thích TRỌN VẸN, từng charge và tổng tiền)
 *                            → expectMissingAtWallet: oracle buộc đối soát ghi bù đúng tập đó, rồi mọi thứ chặt lại;
 *  - mọi trường hợp khác (không có lỗi nào giải thích được, hoặc vi phạm kiểu khác) → assert chặt: sẽ ném đúng vi phạm.
 * Nhờ vậy không có chuyện topup treo vô cớ bị miễn: chỉ trạng thái do lỗi gài MÀ đối soát sửa được mới được tha.
 */
export async function settleAndJudge(
  system: System,
  report: SoakReport,
): Promise<{ missingAtWallet: number; tolerated: boolean }> {
  await system.heal({ allowUnsettledTopups: true, timeoutMs: 240_000 });
  const inv3 = await collectViolations(system, { only: ['INV-3'] });
  const tolerate = inv3.length > 0 && report.webhookAffecting && explainedByMissingAtWallet(inv3);
  system.log.record('soak.judge', { inv3: inv3.length, tolerate });
  await assertSystemInvariants(system, tolerate ? { expectMissingAtWallet: true } : {});
  return { missingAtWallet: inv3.filter(isMissingAtWallet).length, tolerated: tolerate };
}

export type SoakMode = 'inproc' | 'child' | 'mixed';

/** Vòng lẻ chạy inproc, vòng chẵn chạy child khi mode = mixed. */
export const soakRoundMode = (mode: SoakMode, round: number): 'inproc' | 'child' =>
  mode === 'mixed' ? (round % 2 === 1 ? 'inproc' : 'child') : mode;

/**
 * Chạy `rounds` vòng soak liên tiếp (mỗi vòng một hệ mới) và để oracle quyết định. Thất bại: ghi `soak-<seed>-round<k>.json`
 * (nhật ký thao tác + lỗi) vào `outDir`, in lệnh chạy lại `rerun(k)` rồi ném lại lỗi.
 */
export async function runSoakRounds(input: {
  seed: number;
  rounds: number;
  maxSeconds: number;
  mode: SoakMode;
  outDir: string;
  rerun: (round: number) => string;
  onSystem?: (system: System | undefined) => void;
}): Promise<void> {
  const { seed, rounds, maxSeconds, mode, outDir } = input;
  for (let round = 1; round <= rounds; round += 1) {
    const kind = soakRoundMode(mode, round);
    const prng = createPrng(seed).fork(`round-${round}`);
    // Retention THẬT trong ~1/3 số vòng inproc (rút prng ở mọi vòng nên ổn định theo seed). Child bị loại: loadConfig thật của
    // dịch vụ từ chối chu kỳ lẻ phút và số ngày < 7 cho khóa idempotency của payment, nên tiến trình con không chạy được cấu hình này.
    const realRetention = prng.fork('retention').chance(1 / 3) && kind === 'inproc';
    const startedAt = Date.now();
    let system: System | undefined;
    try {
      const options = {
        seed,
        tenants: ['acme', 'beta'],
        ...(realRetention
          ? {
              retention: {
                dryRun: false,
                batchSize: 5,
                intervalMinutes: 0.1,
                days: {
                  wallet: {
                    outboxSent: 1,
                    processedMessages: 1,
                    idempotencyKeys: 1,
                    reconciliation: 1,
                  },
                  payment: { webhook: 1, idempotencyKeys: 1 },
                },
              },
            }
          : {}),
      };
      // Child: wallet có thể chết vài giây; lịch webhook dài như S9 để webhook không hết lượt chỉ vì thế.
      system =
        kind === 'child'
          ? await createSystem({
              ...options,
              mode: 'child',
              webhookBackoffSeconds: [2, 5, 10, 20, 30],
            })
          : await createSystem(options);
      input.onSystem?.(system);
      const report = await runSoakRound({
        system,
        prng,
        durationMs: maxSeconds * 1000,
        mode: kind,
      });
      const verdict = await settleAndJudge(system, report);
      console.info(
        `chaos round=${round}/${rounds} mode=${kind} retention=${realRetention} missingAtWallet=${verdict.missingAtWallet} tolerated=${verdict.tolerated} faults=${report.executed.length}/${report.planned.length} ops=${report.opsStarted.reduce((a, b) => a + b, 0)} clientErrors=${report.opErrors} webhookAffecting=${report.webhookAffecting} ${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
      if (report.executed.length === 0) throw new Error('lịch lỗi phải thực sự bắn lỗi');
      // Từng loại tải chính phải thực sự thành công ít nhất một lần (maxSeconds quá ngắn thì bỏ qua kiểm tra này).
      if (maxSeconds >= 20) {
        for (const op of ['topup', 'order', 'adjust', 'read', 'freeze'] as const) {
          if ((report.succeeded[op] ?? 0) === 0)
            throw new Error(`loại tải ${op} chưa từng thành công`);
        }
      }
    } catch (error) {
      if (system !== undefined) {
        system.log.record('soak.failure', {
          seed,
          round,
          mode: kind,
          error: error instanceof Error ? error.message : String(error),
        });
        const path = await system.log.writeTo(outDir, `soak-${seed}-round${round}`);
        console.error(`[chaos] soak thất bại (seed=${seed}, vòng ${round}); nhật ký: ${path}`);
      }
      console.error(`[chaos] chạy lại: ${input.rerun(round)}`);
      throw error;
    } finally {
      await system?.stop();
      input.onSystem?.(undefined);
    }
  }
}
