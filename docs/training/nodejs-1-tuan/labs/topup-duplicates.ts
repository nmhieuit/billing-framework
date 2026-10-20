// Bài lab Ngày 3: các kiểu "trùng" của luồng nạp tiền, chạy bằng code THẬT của repo.
//   1. RequestTopup (wallet)     : cùng Idempotency-Key tuần tự / đồng thời / khác nội dung
//   2. CreateCharge (payment)    : wallet gửi lại POST /charges cùng key
//   3. ApplyPaymentResult (wallet): webhook giao hai lần
// Thật: use case, domain (Topup, Account, LedgerTransaction, Charge). Giả: DB trong bộ nhớ + độ trễ.
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/topup-duplicates.ts
import { randomUUID } from 'node:crypto';
import { ApplyPaymentResult } from '../../../../services/wallet/src/application/apply-payment-result.js';
import { DuplicateKeyError as WalletDuplicateKeyError } from '../../../../services/wallet/src/application/errors.js';
import type { StoredTopupResponse } from '../../../../services/wallet/src/application/ports.js';
import { RequestTopup } from '../../../../services/wallet/src/application/request-topup.js';
import { Account } from '../../../../services/wallet/src/domain/account.js';
import { CustomerId } from '../../../../services/wallet/src/domain/customer-id.js';
import { TenantId } from '../../../../services/wallet/src/domain/tenant-id.js';
import { Topup } from '../../../../services/wallet/src/domain/topup.js';
import { CreateCharge } from '../../../../services/payment/src/application/create-charge.js';
import { DuplicateKeyError as PaymentDuplicateKeyError } from '../../../../services/payment/src/application/errors.js';
import { Money } from '../../../../packages/money/src/index.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const tenant = TenantId.parse('acme');
const customerId = CustomerId.parse('c1');
const now = () => new Date('2026-10-20T00:00:00Z');
const title = (t: string) => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------------------------------------
// WALLET: DB giả có undo log để mô phỏng rollback khi một giao dịch gặp lỗi.
// ---------------------------------------------------------------------------------------------
function walletDb() {
  const topups = new Map<string, Topup>();
  const idem = new Map<string, StoredTopupResponse>();
  const inbox = new Set<string>();
  const ledgerKeys = new Set<string>();
  const accounts = new Map<string, Account>();
  accounts.set(
    'wallet:c1',
    Account.rehydrate({
      id: 'wallet:c1',
      kind: 'WALLET',
      customerId: 'c1',
      currency: 'VND',
      balance: Money.of(0, 'VND'),
      createdAt: now(),
      frozen: null,
    }),
  );
  accounts.set(
    'system:GATEWAY:VND',
    Account.rehydrate({
      id: 'system:GATEWAY:VND',
      kind: 'GATEWAY',
      customerId: null,
      currency: 'VND',
      balance: Money.of(0, 'VND'),
      createdAt: now(),
      frozen: null,
    }),
  );
  let runs = 0;
  const uow = {
    async run<T>(_t: TenantId, work: (r: never) => Promise<T>): Promise<T> {
      runs += 1;
      const undo: Array<() => void> = [];
      const repos = {
        accounts: {
          async find(id: string) {
            await sleep(10);
            return accounts.get(id) ?? null;
          },
          async lockMany(ids: string[]) {
            return [...ids].sort().map((id) => accounts.get(id)!);
          },
          async saveBalance(a: Account) {
            const id = a.toProps().id;
            const before = accounts.get(id)!;
            accounts.set(id, a);
            undo.push(() => accounts.set(id, before));
          },
        },
        topups: {
          async insert(t: Topup) {
            await sleep(10); // I/O: cả hai request đã đọc "chưa có key" trước khi bên nào kịp ghi
            topups.set(t.toProps().id, t);
            undo.push(() => topups.delete(t.toProps().id));
          },
          async lockById(id: string) {
            return topups.get(id) ?? null;
          },
          async save(t: Topup) {
            const id = t.toProps().id;
            const before = topups.get(id);
            topups.set(id, t);
            undo.push(() => (before ? topups.set(id, before) : topups.delete(id)));
          },
        },
        idempotency: {
          async find(c: string, key: string) {
            return idem.get(`${c}|${key}`) ?? null;
          },
          async save(r: StoredTopupResponse) {
            const k = `${r.customerId}|${r.key}`;
            if (idem.has(k)) throw new WalletDuplicateKeyError(`idempotency key exists: ${k}`);
            idem.set(k, r);
            undo.push(() => idem.delete(k));
          },
        },
        inbox: {
          async record(consumer: string, id: string) {
            const k = `${consumer}/${id}`;
            if (inbox.has(k)) throw new WalletDuplicateKeyError(`already processed: ${k}`, 'inbox');
            inbox.add(k);
            undo.push(() => inbox.delete(k));
          },
        },
        ledger: {
          async post(tx: { toProps(): { businessKey: string } }) {
            const k = tx.toProps().businessKey;
            if (ledgerKeys.has(k)) throw new WalletDuplicateKeyError(`business key exists: ${k}`, 'ledger');
            ledgerKeys.add(k);
            undo.push(() => ledgerKeys.delete(k));
          },
        },
      };
      try {
        return await work(repos as never);
      } catch (error) {
        for (const fn of undo.reverse()) fn(); // ROLLBACK
        throw error;
      }
    },
  };
  return { uow, topups, idem, ledgerKeys, accounts, runCount: () => runs };
}

// ---------------------------------------------------------------------------------------------
title('1a. RequestTopup: gửi lại CÙNG Idempotency-Key, tuần tự');
{
  const db = walletDb();
  let submitted = 0;
  let n = 0;
  const useCase = new RequestTopup({
    uow: db.uow as never,
    clock: { now },
    ids: { topupId: () => `tp_${++n}`, transactionId: () => 't', eventId: () => randomUUID() },
    submitter: { submitSoon: () => void (submitted += 1) },
  });
  const input = { tenant, customerId, idempotencyKey: 'k-1', amount: 50_000 };
  const r1 = await useCase.execute(input);
  const r2 = await useCase.execute(input);
  console.log(`lần 1: replayed=${r1.replayed} topupId=${r1.body.topupId}`);
  console.log(`lần 2: replayed=${r2.replayed} topupId=${r2.body.topupId}`);
  console.log(`số lần submitSoon (gửi sang payment) = ${submitted}; số topup trong DB = ${db.topups.size}`);
}

title('1b. RequestTopup: HAI request đồng thời cùng key (đua)');
{
  const db = walletDb();
  let submitted = 0;
  let n = 0;
  const useCase = new RequestTopup({
    uow: db.uow as never,
    clock: { now },
    ids: { topupId: () => `tp_${++n}`, transactionId: () => 't', eventId: () => randomUUID() },
    submitter: { submitSoon: () => void (submitted += 1) },
  });
  const input = { tenant, customerId, idempotencyKey: 'k-2', amount: 50_000 };
  const [a, b] = await Promise.all([useCase.execute(input), useCase.execute(input)]);
  console.log(`A: replayed=${a.replayed} topupId=${a.body.topupId}`);
  console.log(`B: replayed=${b.replayed} topupId=${b.body.topupId}`);
  console.log(
    `uow.run được gọi ${db.runCount()} lần (2 request + 1 lần thử lại của bên thua); submitSoon = ${submitted}; topup trong DB = ${db.topups.size}`,
  );
}

title('1c. RequestTopup: CÙNG key nhưng NỘI DUNG KHÁC');
{
  const db = walletDb();
  let n = 0;
  const useCase = new RequestTopup({
    uow: db.uow as never,
    clock: { now },
    ids: { topupId: () => `tp_${++n}`, transactionId: () => 't', eventId: () => randomUUID() },
    submitter: { submitSoon: () => {} },
  });
  await useCase.execute({ tenant, customerId, idempotencyKey: 'k-3', amount: 50_000 });
  try {
    await useCase.execute({ tenant, customerId, idempotencyKey: 'k-3', amount: 70_000 });
  } catch (error) {
    console.log(`lỗi: ${(error as Error).name} — ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
title('2. Payment CreateCharge: wallet gửi lại POST /charges cùng Idempotency-Key');
{
  const charges: unknown[] = [];
  const idem = new Map<string, { key: string; requestHash: string; responseStatus: number; responseBody: string; chargeId: string; createdAt: Date }>();
  let id = 0;
  const useCase = new CreateCharge({
    uow: {
      async run(work: (r: never) => Promise<unknown>) {
        const undo: Array<() => void> = [];
        const repos = {
          idempotency: {
            async find(key: string) {
              return idem.get(key) ?? null;
            },
            async save(r: { key: string }) {
              if (idem.has(r.key)) throw new PaymentDuplicateKeyError('key exists');
              idem.set(r.key, r as never);
              undo.push(() => idem.delete(r.key));
            },
          },
          charges: {
            async insert(c: unknown) {
              charges.push(c);
              undo.push(() => charges.pop());
            },
          },
        };
        try {
          return await work(repos as never);
        } catch (error) {
          for (const fn of undo.reverse()) fn();
          throw error;
        }
      },
    } as never,
    clock: { now },
    ids: { chargeId: () => `ch_${++id}`, eventId: () => randomUUID() },
  });
  const input = {
    idempotencyKey: 'topup:acme:tp_1',
    amount: 50_000,
    currency: 'VND',
    reference: 'tp_1',
    metadata: { tenantId: 'acme' },
  };
  const first = await useCase.execute(input);
  const second = await useCase.execute(input); // ví dụ: phản hồi lần 1 bị mất, wallet gửi lại
  console.log(`lần 1: replayed=${first.replayed} chargeId=${first.body.chargeId} status=${first.status}`);
  console.log(`lần 2: replayed=${second.replayed} chargeId=${second.body.chargeId} status=${second.status}`);
  console.log(`số charge được tạo = ${charges.length}`);
  try {
    await useCase.execute({ ...input, amount: 99_000 });
  } catch (error) {
    console.log(`cùng key, amount khác: ${(error as Error).name}`);
  }
}

// ---------------------------------------------------------------------------------------------
title('3. Wallet ApplyPaymentResult: webhook giao HAI LẦN (cùng eventId)');
{
  const db = walletDb();
  db.topups.set(
    'tp_9',
    Topup.rehydrate({
      id: 'tp_9',
      customerId: 'c1',
      accountId: 'wallet:c1',
      amount: Money.of(50_000, 'VND'),
      status: 'PENDING',
      chargeId: 'ch_9',
      failureCode: null,
      attempts: 1,
      nextAttemptAt: null,
      createdAt: now(),
      completedAt: null,
    }),
  );
  const logs: string[] = [];
  const useCase = new ApplyPaymentResult({
    uow: db.uow as never,
    clock: { now },
    ids: { topupId: () => 'x', transactionId: () => 'tx_1', eventId: () => randomUUID() },
    log: { info: () => {}, warn: (_d, m) => void logs.push(`warn: ${m}`), error: (_d, m) => void logs.push(`error: ${m}`) },
  });
  const event = {
    tenant,
    eventId: 'evt-1',
    type: 'charge.succeeded' as const,
    chargeId: 'ch_9',
    reference: 'tp_9',
    amount: 50_000,
    currency: 'VND',
  };
  const o1 = await useCase.execute(event);
  const o2 = await useCase.execute(event);
  console.log(`lần 1: ${o1}   lần 2: ${o2}`);
  console.log(`số dư ví = ${db.accounts.get('wallet:c1')!.toProps().balance.amount}; giao dịch sổ cái = ${db.ledgerKeys.size} (${[...db.ledgerKeys].join(', ')})`);
  console.log(`trạng thái topup = ${db.topups.get('tp_9')!.toProps().status}; log bất thường: ${logs.length === 0 ? '(không)' : logs.join(' | ')}`);
}
