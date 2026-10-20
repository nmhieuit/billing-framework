// Bài lab Ngày 2: luồng NẠP TIỀN thật (POST /topups) với code thật của repo.
//   - RequestTopup          (services/wallet/src/application/request-topup.ts)  : thật
//   - InlineTopupSubmitter  (services/wallet/src/application/inline-topup-submitter.ts) : thật
//   - createShutdownHandler (packages/runtime/src/lifecycle.ts)                   : thật
// Chỉ DB và cổng gọi payment (HTTP POST /charges) là bản giả có độ trễ.
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/topup-async-flow.ts
import { RequestTopup } from '../../../../services/wallet/src/application/request-topup.js';
import { InlineTopupSubmitter } from '../../../../services/wallet/src/application/inline-topup-submitter.js';
import type { TenantUnitOfWork } from '../../../../services/wallet/src/application/ports.js';
import { Account } from '../../../../services/wallet/src/domain/account.js';
import { CustomerId } from '../../../../services/wallet/src/domain/customer-id.js';
import { TenantId } from '../../../../services/wallet/src/domain/tenant-id.js';
import { Money } from '../../../../packages/money/src/index.js';
import { createShutdownHandler } from '../../../../packages/runtime/src/index.js';

const t0 = Date.now();
const log = (msg: string): void => console.log(`+${String(Date.now() - t0).padStart(3)}ms  ${msg}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---- DB giả: mỗi lần chạm DB tốn thời gian ----
const saved: string[] = [];
const fakeUow: TenantUnitOfWork = {
  async run(_tenant, work) {
    log('    [DB] BEGIN');
    await sleep(15);
    const result = await work({
      accounts: {
        async find(id: string) {
          await sleep(10);
          return Account.rehydrate({
            id,
            kind: 'WALLET',
            customerId: id.replace('wallet:', ''),
            currency: 'VND',
            balance: Money.of(0, 'VND'),
            createdAt: new Date('2026-01-01T00:00:00Z'),
            frozen: null,
          });
        },
      },
      idempotency: {
        async find() {
          return null;
        },
        async save() {},
      },
      topups: {
        async insert(topup: { toProps(): { id: string } }) {
          await sleep(10);
          saved.push(topup.toProps().id);
        },
      },
    } as never);
    await sleep(10);
    log('    [DB] COMMIT');
    return result;
  },
};

// ---- Cổng gọi payment giả: HTTP POST /charges mất 60ms, có thể lỗi ----
let paymentDown = false;
const fakeSubmit = {
  async executeFor(_tenant: TenantId, topupId: string): Promise<void> {
    log(`    [gateway] gửi HTTP POST /charges cho ${topupId} (phần đồng bộ của executeFor chạy NGAY)`);
    await sleep(60); // I/O: chờ payment trả lời
    if (paymentDown) throw new Error('payment unavailable (ECONNREFUSED)');
    log(`    [gateway] payment trả 202 cho ${topupId}`);
  },
};

const logger = {
  info: () => {},
  warn: () => {},
  error: (details: object, message?: string) => log(`    [log.error] ${message ?? ''} err=${String((details as { err?: Error }).err?.message)}`),
};
const submitter = new InlineTopupSubmitter({ submit: fakeSubmit as never, log: logger });

let n = 0;
const requestTopup = new RequestTopup({
  uow: fakeUow,
  clock: { now: () => new Date() },
  ids: { topupId: () => `tp_${++n}` } as never,
  submitter,
});

const tenant = TenantId.parse('acme');
const customerId = CustomerId.parse('c1');

// Giống TopupsController: gọi use case, rồi trả 202 cho client.
async function postTopups(name: string): Promise<void> {
  log(`${name}: POST /topups đến`);
  const result = await requestTopup.execute({ tenant, customerId, idempotencyKey: `k-${name}`, amount: 50_000 });
  log(`${name}: >>> TRẢ ${result.status} CHO CLIENT (topupId=${result.body.topupId})`);
}

console.log('=== A. Thành công: client nhận 202 TRƯỚC khi payment trả lời ===');
await postTopups('A');
log('A: handler xong. Client đã có 202, nhưng việc gửi sang payment VẪN đang chạy nền.');
await sleep(80);
console.log('');

console.log('=== B. Payment chết: client VẪN nhận 202, lỗi chỉ được log (worker sẽ gửi lại) ===');
paymentDown = true;
await postTopups('B');
await sleep(80);
paymentDown = false;
console.log('');

console.log('=== C. Tắt dịch vụ khi còn lần gửi đang chạy: drain() chờ, Promise.race giới hạn thời gian ===');
await postTopups('C');
const shutdown = createShutdownHandler({
  stop: async () => {
    log('shutdown: bắt đầu dừng (đợi các lần gửi đang chạy)');
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 500); // main.ts dùng 5_000
    });
    await Promise.race([submitter.drain(), timeout]);
    clearTimeout(timer);
    log('shutdown: drain xong');
  },
  log: { info: () => {}, error: () => {} },
  exit: (code) => log(`shutdown: exit(${code}) được gọi (từ .then của createShutdownHandler)`),
});
shutdown('SIGTERM');
await sleep(150);
log(`Tổng số topup đã lưu DB: ${saved.length}`);
