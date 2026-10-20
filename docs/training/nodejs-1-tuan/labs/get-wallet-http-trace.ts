// Bài lab Ngày 3: vết chạy THẬT của GET /wallet qua ứng dụng NestJS + Fastify của wallet (createApp thật).
// Thật: Fastify, Nest, CorrelationMiddleware, CallerGuard, WalletsController, GetWallet, Account, toWalletView.
// Giả : DB (uow + accounts.find có độ trễ) và các use case khác của AppDeps (không dùng tới).
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/get-wallet-http-trace.ts
import { GetWallet } from '../../../../services/wallet/src/application/get-wallet.js';
import type { TenantUnitOfWork } from '../../../../services/wallet/src/application/ports.js';
import { Account } from '../../../../services/wallet/src/domain/account.js';
import { TenantId } from '../../../../services/wallet/src/domain/tenant-id.js';
import { ConfigTenantRegistry } from '../../../../services/wallet/src/infrastructure/tenant-registry.js';
import { createApp } from '../../../../services/wallet/src/interface/http/create-app.js';
import { Money } from '../../../../packages/money/src/index.js';
import { getCorrelationId } from '../../../../packages/observability/src/index.js';

const t0 = Date.now();
const log = (msg: string): void => console.log(`+${String(Date.now() - t0).padStart(3)}ms  ${msg}`);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const short = (id: string | undefined): string => (id ?? '(none)').slice(0, 8);

const acme = TenantId.parse('acme');
const realRegistry = new ConfigTenantRegistry([acme]);
// Bọc registry để thấy lúc CallerGuard gọi nó (và id correlation đã có hay chưa).
const registry = {
  all: () => realRegistry.all(),
  resolve(raw: string | undefined) {
    log(`  [2 CallerGuard] registry.resolve("${raw}")   correlation=${short(getCorrelationId())}`);
    return realRegistry.resolve(raw);
  },
};

// DB giả: mỗi lần chạm DB tốn thời gian (thay cho SQL Server).
const fakeUow: TenantUnitOfWork = {
  async run(tenant, work) {
    log(`  [5 uow.run] BEGIN transaction (tenant ${tenant.value})  correlation=${short(getCorrelationId())}`);
    await sleep(20);
    const result = await work({
      accounts: {
        async find(id: string) {
          log(`  [6 accounts.find] SELECT ... WHERE id='${id}'  correlation=${short(getCorrelationId())}`);
          await sleep(30);
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
    await sleep(10);
    log(`  [7 uow.run] COMMIT  correlation=${short(getCorrelationId())}`);
    return result;
  },
};

const realGetWallet = new GetWallet({ uow: fakeUow });
const getWallet = {
  execute(input: Parameters<GetWallet['execute']>[0]) {
    log(`  [4 GetWallet.execute] customer=${input.customerId.value}  correlation=${short(getCorrelationId())}`);
    return realGetWallet.execute(input);
  },
};

const unused = { execute: async () => ({}) as never };
const app = await createApp({
  registry,
  clock: { now: () => new Date() },
  log: { info: () => {}, warn: () => {}, error: () => {} },
  webhookSecret: 'lab',
  createWallet: unused,
  getWallet,
  listEntries: unused,
  requestTopup: unused,
  getTopup: unused,
  applyPaymentResult: unused,
  startReconciliation: unused,
  getReconciliationRun: unused,
  listReconciliationItems: unused,
  resolveReconciliationItem: unused,
  freezeWallet: unused,
  adjustWallet: unused,
  reverseTransaction: unused,
  replayOrderPaid: unused,
  listOpsActions: unused,
});
const fastify = app.getHttpAdapter().getInstance();

async function getWalletRequest(name: string, customer: string, cid: string): Promise<void> {
  log(`${name}: >>> GET /wallet (customer ${customer}, x-correlation-id ${short(cid)})`);
  const res = await fastify.inject({
    method: 'GET',
    url: '/wallet',
    headers: { 'x-tenant-id': 'acme', 'x-customer-id': customer, 'x-correlation-id': cid },
  });
  log(`${name}: <<< ${res.statusCode} ${res.body}  (response x-correlation-id=${short(String(res.headers['x-correlation-id']))})`);
}

console.log('=== 1. MỘT request: thứ tự các hàm của repo ===');
await getWalletRequest('A', 'c1', 'aaaaaaaa-0000-4000-8000-000000000001');

console.log('\n=== 2. HAI request chồng nhau (cùng endpoint, cùng lúc) ===');
const t1 = Date.now();
await Promise.all([
  getWalletRequest('A', 'c1', 'aaaaaaaa-0000-4000-8000-000000000001'),
  getWalletRequest('B', 'c2', 'bbbbbbbb-0000-4000-8000-000000000002'),
]);
log(`tổng thời gian hai request chồng nhau: ${Date.now() - t1}ms (một request tuần tự ≈ 60ms DB giả)`);

await app.close();
