// Bài lab Ngày 3: payment PHẢN HỒI CHẬM -> timeout -> retry theo backoff -> FAILED, bằng code THẬT của repo.
// Thật: HttpPaymentGateway (AbortSignal.timeout), SubmitTopup, Topup (recordUnavailable, isDue, claim, applySucceeded).
// Giả : mạng (fetch bị treo đến khi bị hủy), DB trong bộ nhớ, đồng hồ (nhảy tới next_attempt_at, không chờ thật).
// Repo KHÔNG có circuit breaker; lab này chỉ đo cơ chế có thật: timeout + retry theo bậc.
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/topup-slow-payment-retry.ts
import { SubmitTopup } from '../../../../services/wallet/src/application/submit-topup.js';
import { HttpPaymentGateway } from '../../../../services/wallet/src/infrastructure/http-payment-gateway.js';
import { CustomerId } from '../../../../services/wallet/src/domain/customer-id.js';
import { TenantId } from '../../../../services/wallet/src/domain/tenant-id.js';
import { Topup } from '../../../../services/wallet/src/domain/topup.js';
import { Money } from '../../../../packages/money/src/index.js';

const tenant = TenantId.parse('acme');
const BACKOFF = [1, 5, 30, 120, 600]; // mặc định của TOPUP_SUBMIT_BACKOFF (config.ts:41)
const TIMEOUT_MS = 200; // thật: PAYMENT_TIMEOUT_MS mặc định 5000 (config.ts:168); rút ngắn để lab chạy nhanh

let fakeNow = new Date('2026-10-20T00:00:00.000Z');
const clock = { now: () => new Date(fakeNow) };
const fmt = (d: Date | null) => (d ? `+${Math.round((d.getTime() - T0) / 1000)}s` : 'null');
const T0 = fakeNow.getTime();

function makeWorld(paymentBehavior: (call: number) => 'hang' | 'ok') {
  let current = Topup.request({
    id: 'tp_1',
    customerId: CustomerId.parse('c1'),
    accountId: 'wallet:c1',
    amount: Money.of(50_000, 'VND'),
    now: clock.now(),
  });
  let calls = 0;
  const logs: string[] = [];
  const snapshotInsideCall: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    const p = current.toProps();
    snapshotInsideCall.push(
      `  [trong lúc chờ payment] status=${p.status} attempts=${p.attempts} next_attempt_at=${fmt(p.nextAttemptAt)} (lease 60s)`,
    );
    if (paymentBehavior(calls) === 'ok') {
      return new Response(JSON.stringify({ chargeId: 'ch_1' }), { status: 202 });
    }
    // Payment "chậm": không bao giờ trả lời, chỉ kết thúc khi bị hủy bởi AbortSignal.timeout.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const submit = new SubmitTopup({
    uow: {
      async run(_t: TenantId, work: (r: never) => Promise<unknown>) {
        return work({
          topups: {
            async lockById() {
              return current;
            },
            async lockNextDue(now: Date) {
              return current.isDue(now) ? current : null;
            },
            async save(t: Topup) {
              current = t;
            },
          },
        } as never);
      },
    } as never,
    gateway: new HttpPaymentGateway({ baseUrl: 'http://payment.invalid', timeoutMs: TIMEOUT_MS, fetchImpl }),
    clock,
    log: {
      info: () => {},
      warn: (_d, m) => void logs.push(`warn: ${m}`),
      error: (_d, m) => void logs.push(`error: ${m}`),
    },
    backoffSeconds: BACKOFF,
  });
  return { submit, topup: () => current, logs, snapshotInsideCall, calls: () => calls };
}

async function runUntilSettled(name: string, behavior: (call: number) => 'hang' | 'ok') {
  fakeNow = new Date(T0); // mỗi kịch bản bắt đầu từ mốc 0
  console.log(`\n=== ${name} ===`);
  const w = makeWorld(behavior);
  for (let round = 1; round <= 8; round += 1) {
    const before = w.topup().toProps();
    if (before.nextAttemptAt === null) break;
    fakeNow = new Date(Math.max(fakeNow.getTime(), before.nextAttemptAt.getTime())); // đồng hồ nhảy tới hạn
    const started = Date.now();
    const outcome = await w.submit.executeNextDue(tenant); // đây là việc Worker làm mỗi tick
    const after = w.topup().toProps();
    console.log(
      `lần gọi ${w.calls()} (đồng hồ ${fmt(fakeNow)}): kết quả=${outcome} sau ${Date.now() - started}ms | status=${after.status} attempts=${after.attempts} next_attempt_at=${fmt(after.nextAttemptAt)} failure=${after.failureCode ?? '-'}`,
    );
    if (round === 1) console.log(w.snapshotInsideCall[0]);
    if (after.status !== 'REQUESTED') break;
  }
  return w;
}

// Timer của AbortSignal.timeout không giữ process sống (unref); service thật còn HTTP server, worker... nên không bị ảnh hưởng.
const keepAlive = setInterval(() => {}, 1000);
const failing = await runUntilSettled('A. Payment luôn chậm: retry hết bậc backoff', () => 'hang');
console.log(`log của wallet: ${[...new Set(failing.logs)].join(' | ')}`);
const late = failing.topup().applySucceeded('ch_late', fakeNow);
console.log(`webhook thành công ĐẾN MUỘN sau khi FAILED: ${failing.topup().toProps().status} -> ${late.toProps().status} (topup.ts:119-125)`);

await runUntilSettled('B. Payment chậm 2 lần đầu rồi hồi phục', (call) => (call <= 2 ? 'hang' : 'ok'));

clearInterval(keepAlive);
