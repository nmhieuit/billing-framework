// Bài lab Ngày 2: chạy THẬT use case GetWallet (code của endpoint GET /wallet) với DB giả.
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/get-wallet-async.ts
// Đoán thứ tự dòng in ra TRƯỚC khi chạy.
import { GetWallet } from '../../../../services/wallet/src/application/get-wallet.js';
import type { TenantUnitOfWork } from '../../../../services/wallet/src/application/ports.js';
import { Account } from '../../../../services/wallet/src/domain/account.js';
import { CustomerId } from '../../../../services/wallet/src/domain/customer-id.js';
import { TenantId } from '../../../../services/wallet/src/domain/tenant-id.js';
import { Money } from '../../../../packages/money/src/index.js';

const t0 = Date.now();
const log = (msg: string): void => console.log(`+${String(Date.now() - t0).padStart(3)}ms  ${msg}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// DB giả: mỗi lần chạm DB tốn thời gian (thay cho SQL Server). Phần còn lại là code thật của repo.
const fakeUow: TenantUnitOfWork = {
  async run(tenant, work) {
    log(`    [uow.run] mở transaction tenant=${tenant.value}`);
    await sleep(20); // I/O: BEGIN TRANSACTION
    const result = await work({
      accounts: {
        async find(id: string) {
          log(`    [accounts.find] gửi SQL cho ${id}`);
          await sleep(30); // I/O: SELECT
          return Account.rehydrate({
            id,
            kind: 'WALLET',
            customerId: id.replace('wallet:', ''),
            currency: 'VND',
            balance: Money.of(150_000, 'VND'),
            createdAt: new Date('2026-01-01T00:00:00Z'),
            frozen: null,
          });
        },
      },
    } as never);
    await sleep(10); // I/O: COMMIT
    log('    [uow.run] commit xong');
    return result;
  },
};

const getWallet = new GetWallet({ uow: fakeUow });
const tenant = TenantId.parse('acme');

// Giống WalletsController.get: gọi use case rồi trả kết quả.
async function handleGetWallet(name: string, customer: string): Promise<void> {
  log(`${name}: vào handler (đồng bộ)`);
  const view = await getWallet.execute({ tenant, customerId: CustomerId.parse(customer) });
  log(`${name}: nhận kết quả balance=${view.balance} (chạy tiếp sau await)`);
}

log('A: bắt đầu (đồng bộ)');
const p1 = handleGetWallet('req1', 'c1');
const p2 = handleGetWallet('req2', 'c2');
log('B: đã gọi cả hai handler nhưng CHƯA có kết quả (vẫn đồng bộ)');
process.nextTick(() => log('C: process.nextTick'));
queueMicrotask(() => log('D: queueMicrotask'));
void Promise.resolve().then(() => log('E: Promise.then (microtask)'));
setTimeout(() => log('F: setTimeout 0ms (macrotask)'), 0);
log('G: hết phần đồng bộ của file');
await Promise.all([p1, p2]);
log('H: cả hai request xong');
