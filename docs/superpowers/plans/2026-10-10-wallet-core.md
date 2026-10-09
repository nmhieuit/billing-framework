# Wallet Core (Bước 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hiện thực service `wallet` theo spec `docs/superpowers/specs/2026-10-10-wallet-core-design.md`: ví theo khách hàng và theo tenant (schema riêng), ledger ghi sổ kép bất biến, nạp tiền qua `payment` (gọi HTTP kiểu lai + webhook), chống trùng nhiều lớp, inbox; cùng hai việc nền: tách `@billing/runtime` và mở rộng payment với `metadata`.

**Architecture:** Bốn lớp hexagonal (`domain` thuần → `application` use case + port → `infrastructure` Kysely/HTTP → `interface` NestJS). Mọi truy cập DB đi qua `TenantUnitOfWork.run(tenant: TenantId, work)`; repository dựng trên schema `t_<tenant>` của database `billing_wallet`. Nạp tiền: `POST /topups` ghi `REQUESTED` rồi kích hoạt một lần thử; worker thử lại các lần nạp đến hạn (cùng use case `SubmitTopup`); kết quả cuối đến từ webhook đã ký HMAC, trong đó tenant lấy từ `data.metadata.tenantId`.

**Tech Stack:** Node 22, TypeScript strict, NestJS 12 trên Fastify 5, Kysely 0.29 (+ tedious/tarn) trên SQL Server 2022, Vitest 5, testcontainers, `@billing/{money,database,contracts,observability,testing}` và `@billing/runtime` (mới).

## Global Constraints

Sao chép nguyên văn từ spec wallet, spec payment và spec nền tảng:

- Tiền là `Money` (số nguyên minor unit + currency `VND|USD`), không float. `bigint` đọc từ SQL Server về là **chuỗi** → luôn qua `toSafeInteger`; ngày giờ luôn ghi/so sánh bằng `dateTime(date)` (cast `datetime2(3)`), không bao giờ truyền `Date` trực tiếp.
- Tenant: `tenantId` khớp `^[a-z][a-z0-9-]{0,39}$` và thuộc `WALLET_TENANTS`; lấy từ header `X-Tenant-Id` (API) hoặc từ `data.metadata.tenantId` của webhook **sau khi** xác thực chữ ký; **không bao giờ** từ body/query. `customerId` khớp `^[A-Za-z0-9_-]{1,64}$` (header `X-Customer-Id`). Thiếu tenant → `400 MISSING_TENANT`; tenant lạ/sai dạng → `403 UNKNOWN_TENANT`; thiếu khách → `400 MISSING_CUSTOMER`.
- Mỗi tenant một schema `t_<tenant>` trong database `billing_wallet`; không có bảng toàn cục. Tên schema chỉ dựng từ `TenantId` đã kiểm tra và luôn được quote (`sql.id`); câu SQL thô luôn dùng tên bảng có schema.
- Sổ kép: mỗi dòng `amount` có dấu, khác 0; tổng các dòng của giao dịch bằng 0; số dư tài khoản = tổng các dòng của nó; ví `balance >= 0`, `GATEWAY` `balance <= 0`, `MERCHANT` `balance >= 0`; nạp `X` = ví `+X`, `GATEWAY −X`; `business_key` unique (`topup:<topupId>`); `ledger_entries`/`ledger_transactions` bất biến bằng trigger `INSTEAD OF UPDATE, DELETE` (lỗi `50001`).
- Khóa tài khoản khi ghi sổ: `UPDLOCK, ROWLOCK` từng tài khoản theo thứ tự `id` tăng dần trong cùng transaction. Worker chọn việc bằng `top (1) ... with (updlock, readpast, rowlock)` và cần index khớp `ORDER BY`.
- `Idempotency-Key` API: 1..255 ký tự, không khoảng trắng đầu/cuối; khóa chính `(customer_id, idempotency_key)` collation `Latin1_General_100_BIN2`; cùng key + cùng nội dung → trả lại phản hồi đã lưu; khác nội dung → `422 IDEMPOTENCY_KEY_REUSED`.
- Gọi payment: `Idempotency-Key = topup:<tenant>:<topupId>`, `reference = <topupId>`, `metadata = { tenantId }`; `202` → `PENDING`; `4xx` → `FAILED` `PAYMENT_REJECTED`; lỗi mạng/timeout/`5xx` → thử lại theo `TOPUP_SUBMIT_BACKOFF` (mặc định `1,5,30,120,600` s: lần thất bại thứ `n <= len` hẹn lại sau `backoff[n-1]`, thứ `len+1` → `FAILED` `PAYMENT_UNAVAILABLE`).
- Webhook: kiểm `X-Signature` trên body thô bằng `verifyWebhook`; inbox `(consumer = "payment-webhook", message_id = eventId)`; không bí mật nào được xuất hiện trong log hay thông báo lỗi.
- Bốn lớp, lint ép ranh giới: `domain/` chỉ import `@billing/money` và file cùng lớp; `application/` không import `kysely`, framework hay `infrastructure/`; service không import service khác. NestJS luôn `@Inject(TOKEN)` tường minh.
- Lệnh chạy qua `corepack pnpm ...` từ gốc repo `C:\Users\ngantran\source\repos\billing-framework`; pnpm ghim `9.15.9`, TypeScript `~5.9`. Test unit `*.test.ts` (không Docker); test tích hợp `*.integration.test.ts` (Docker, `corepack pnpm test:integration <filter>`, **không** có `--` trước filter).

## Những điều đã kiểm chứng bằng thử nghiệm thật (code trong plan phụ thuộc vào chúng)

1. **NestJS 12 + Fastify:** `NestFactory.create(AppModule, new FastifyAdapter(), { rawBody: true, logger: false })` làm `req.rawBody` (Buffer) giữ **nguyên từng ký tự** của body gửi lên (kể cả khoảng trắng); đọc bằng `@Req() req: RawBodyRequest<FastifyRequest>`. `POST` mặc định trả `201` nên endpoint `202` cần `@HttpCode(202)`. Bộ lọc bắt-mọi-lỗi đăng ký qua `{ provide: APP_FILTER, useClass: ... }` bắt được cả lỗi domain lẫn `HttpException` (JSON hỏng → `400`, route lạ → `404`). `NestFastifyApplication` có `inject` để test. Cần `experimentalDecorators` (đã bật trong `tsconfig.base.json`).
2. **Kysely `Migrator` trên SQL Server cần thành viên `db_owner`:** khóa migration dùng `sp_getapplock` với `dbo`; user chỉ có `db_datareader`/`db_datawriter`/`db_ddladmin` gặp lỗi `The database-principal 'dbo' does not exist or user is not a member`. Vì vậy lệnh migrate phải chạy bằng thông tin đăng nhập riêng (`*_MIGRATOR_DB_USER/PASSWORD`, thành viên `db_owner`); user ứng dụng chỉ cần DML. Điều này **cũng áp dụng cho `db:migrate:payment` của Bước 2** (sửa ở Task 14).
3. `create schema` chạy được bằng user `db_ddladmin`; `if not exists (select 1 from sys.schemas where name = '...') exec('create schema [...]')` idempotent. `Migrator({ migrationTableSchema: '<schema>' })` đặt bảng theo dõi trong schema (schema phải tồn tại trước) và chạy lại là no-op.
4. `db.withSchema('t_x').selectFrom('accounts')` biên dịch thành `"t_x"."accounts"`; `sql.id('t_x', 'accounts')` và `sql.table('t_x.accounts')` đều hợp lệ; `insertInto(...).output('inserted.id')` trả `[{ id: '1' }]` (id dạng **chuỗi**). Hai schema cùng tên bảng và cùng `id` cô lập hoàn toàn.
5. Trigger `instead of update, delete as begin throw 50001, 'ledger is immutable', 1; end` chặn cả `UPDATE` lẫn `DELETE` (lỗi `50001`) mà `INSERT` vẫn chạy; vi phạm `CHECK` báo lỗi `547`; vi phạm khóa duy nhất `2627/2601` (đã có `isUniqueViolation`).

## File Structure

```
billing-framework/
├─ db/
│  ├─ payment/002-metadata.ts                    # mới (+ sửa migrations.ts, migrate.ts)
│  └─ wallet/migrate.ts                           # `db:migrate:wallet`; migration nằm trong services/wallet (theo schema tenant)
├─ deploy/           sql/init.sql, compose.billing.yml, .env.example                          # thêm login migrator (db_owner)
├─ packages/
│  ├─ runtime/       src/{index,worker,lifecycle}.ts + worker.test.ts + lifecycle.test.ts   # chuyển từ payment
│  ├─ database/      src/{migrate,config,errors}.ts (migrationTableSchema, pendingMigrations, migratorConfigFromEnv, isMissingObject)
│  ├─ contracts/     src/webhook.ts (thêm data.metadata)
│  └─ testing/       src/{fake-payment-server,free-port}.ts
├─ tests/e2e/        billing.integration.test.ts                                               # payment thật + wallet thật
├─ docs/adr/         0006-tenant-schema-per-tenant, 0007-topup-hybrid-submit-and-layered-dedup
├─ services/payment/ (sửa: metadata xuyên domain/application/infrastructure/interface)
└─ services/wallet/
   ├─ .env.example
   └─ src/
      ├─ config.ts  bootstrap.ts  main.ts  app.module.ts  test-support.ts  service.integration.test.ts  env-example.test.ts
      ├─ domain/{errors,tenant-id,customer-id,account,ledger-transaction,topup}.ts + *.test.ts
      ├─ application/{errors,ports,views,create-wallet,get-wallet,list-entries,request-topup,get-topup,submit-topup,submit-due-topups,inline-topup-submitter,apply-payment-result}.ts + *.integration.test.ts
      ├─ infrastructure/{tenant-registry,system,http-payment-gateway}.ts + kysely/{schema,schema-name,mappers,account.repository,ledger.repository,topup.repository,idempotency.repository,inbox.repository,unit-of-work,provisioning}.ts + kysely/migrations/{001-ledger,002-topups,index}.ts
      └─ interface/http/{tokens,errors,caller.guard,create-app,health.controller,correlation.middleware,wallets.controller,topups.controller,webhooks.controller}.ts + api.integration.test.ts
```

Quy ước test: test trong `domain/` và `application/` không import `kysely` hay `infrastructure/` (lint cấm); test tích hợp dùng `services/wallet/src/test-support.ts`.

---

### Task 1: `@billing/runtime` (tách Worker và lifecycle khỏi payment)

**Files:**
- Create: `packages/runtime/package.json`, `packages/runtime/src/index.ts`
- Move (git mv, nội dung giữ nguyên): `services/payment/src/infrastructure/worker.ts` → `packages/runtime/src/worker.ts`; `services/payment/src/infrastructure/worker.test.ts` → `packages/runtime/src/worker.test.ts`; `services/payment/src/lifecycle.ts` → `packages/runtime/src/lifecycle.ts`; `services/payment/src/lifecycle.test.ts` → `packages/runtime/src/lifecycle.test.ts`
- Modify: `services/payment/src/bootstrap.ts`, `services/payment/src/main.ts`, `services/payment/package.json` (qua pnpm)

**Interfaces:**
- Produces (từ `@billing/runtime`): `Worker`, `WorkerOptions`, `runAll`, `once`, `createShutdownHandler`, `startOrExit`, `ShutdownLogger`, `ShutdownOptions`, `StartupOptions` — **chữ ký và hành vi giữ nguyên** như hiện có trong payment (`Worker` tasks nhận `AbortSignal`; `stop()` abort trước khi chờ; `onError` ném lỗi không làm chết vòng lặp; `once` memoize cả lỗi; `startOrExit` dừng service nếu khởi động lỗi rồi `exit(1)`).

Đây là việc **di chuyển thuần túy**, không phải hành vi mới: bằng chứng là toàn bộ test hiện có (đã chuyển đi) và test payment vẫn đạt, nên không có bước RED.

- [ ] **Step 1: Xác nhận chỉ có hai nơi trong payment dùng các module sắp chuyển**

Run:
```bash
grep -rn "infrastructure/worker\|/lifecycle\.js\|'./lifecycle\|from './worker" services/payment/src --include=*.ts | grep -v "\.test\.ts"
```
Expected: chỉ `services/payment/src/bootstrap.ts` (import `./infrastructure/worker.js` và `./lifecycle.js`) và `services/payment/src/main.ts` (import `./lifecycle.js`). Nếu còn nơi khác, cập nhật import ở đó theo cùng cách ở Step 4.

- [ ] **Step 2: Chuyển file và tạo package**

```bash
mkdir -p packages/runtime/src
git mv services/payment/src/infrastructure/worker.ts packages/runtime/src/worker.ts
git mv services/payment/src/infrastructure/worker.test.ts packages/runtime/src/worker.test.ts
git mv services/payment/src/lifecycle.ts packages/runtime/src/lifecycle.ts
git mv services/payment/src/lifecycle.test.ts packages/runtime/src/lifecycle.test.ts
```

`packages/runtime/package.json`:
```json
{
  "name": "@billing/runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

`packages/runtime/src/index.ts`:
```ts
export { Worker } from './worker.js';
export type { WorkerOptions } from './worker.js';
export { createShutdownHandler, once, runAll, startOrExit } from './lifecycle.js';
export type { ShutdownLogger, ShutdownOptions, StartupOptions } from './lifecycle.js';
```

- [ ] **Step 3: Khai báo phụ thuộc**

```bash
corepack pnpm --filter @billing/runtime add -D @billing/testing@workspace:*
corepack pnpm --filter @billing/payment-service add @billing/runtime@workspace:*
```
Expected: không lỗi (`worker.test.ts` dùng `waitFor` của `@billing/testing`).

- [ ] **Step 4: Đổi import trong payment**

Trong `services/payment/src/bootstrap.ts`: thay hai dòng
```ts
import { Worker } from './infrastructure/worker.js';
```
và
```ts
import { once, runAll } from './lifecycle.js';
```
bằng một dòng duy nhất (đặt cùng nhóm import `@billing/*` ở đầu file):
```ts
import { Worker, once, runAll } from '@billing/runtime';
```

Trong `services/payment/src/main.ts`: thay
```ts
import { createShutdownHandler, startOrExit } from './lifecycle.js';
```
bằng
```ts
import { createShutdownHandler, startOrExit } from '@billing/runtime';
```

- [ ] **Step 5: Chạy toàn bộ kiểm tra**

```bash
corepack pnpm exec vitest run packages/runtime services/payment
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test:integration service.integration
```
Expected: PASS. Nếu `format:check` báo lệch ở các file vừa sửa, `corepack pnpm exec prettier --write` đúng các file đó. `service.integration` (payment e2e, cần Docker) xác nhận worker/lifecycle chuyển đi vẫn chạy đúng khi nối dây thật.

- [ ] **Step 6: Commit**

```bash
git add -A packages/runtime services/payment pnpm-lock.yaml
git commit -m "refactor: extract Worker and lifecycle helpers into @billing/runtime"
```

---

### Task 2: Payment hỗ trợ `metadata`

**Files:**
- Modify: `packages/contracts/src/webhook.ts`; `services/payment/src/domain/charge.ts` (viết lại), `domain/webhook-event.ts`, `application/create-charge.ts` (viết lại), `application/views.ts` (viết lại), `application/get-settlement.ts`, `infrastructure/kysely/mappers.ts` (viết lại), `infrastructure/kysely/schema.ts`, `infrastructure/kysely/charge.repository.ts`, `interface/http/charges.route.ts`; `db/payment/migrations.ts`, `db/payment/migrations.integration.test.ts` (một dòng)
- Create: `services/payment/src/domain/metadata.ts`, `db/payment/002-metadata.ts`
- Test: `packages/contracts/src/webhook.metadata.test.ts`, `services/payment/src/domain/metadata.test.ts`, `services/payment/src/domain/webhook-event.metadata.test.ts`, `services/payment/src/application/create-charge.metadata.integration.test.ts`, `services/payment/src/application/get-settlement.metadata.integration.test.ts`, `services/payment/src/interface/http/charges.metadata.route.test.ts`

**Interfaces:**
- Produces:
  - `type Metadata = Readonly<Record<string, string>>`, `EMPTY_METADATA`, `MAX_METADATA_KEYS = 10`, `MAX_METADATA_VALUE_LENGTH = 200`, `parseMetadata(raw: unknown): Metadata` (ném `InvalidChargeError`; trả về đối tượng với khóa đã **sắp xếp**; `undefined` → `EMPTY_METADATA`), `parseStoredMetadata(raw: string | null): Metadata`
  - `ChargeProps.metadata: Metadata`; `Charge.create({ ..., metadata?: Metadata })`
  - `CreateChargeInput.metadata?: unknown`
  - `ChargeCreatedView.metadata?`, `ChargeView.metadata?`, `SettlementItem.metadata?`, webhook `data.metadata?` — **chỉ xuất hiện khi không rỗng**
  - cột `charges.metadata nvarchar(max) null` (migration `002-metadata`)
- Quy tắc: tối đa 10 khóa, khóa khớp `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, giá trị là chuỗi tối đa 200 ký tự; sai → `InvalidChargeError` (HTTP `400 INVALID_REQUEST`). `metadata` nằm trong hash idempotency **chỉ khi không rỗng** (để request cũ không có metadata giữ nguyên hash).

- [ ] **Step 1: Viết test thất bại (contract, domain)**

`packages/contracts/src/webhook.metadata.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { validateChargeWebhook } from './index.js';

const base = {
  eventId: 'evt_1',
  type: 'charge.succeeded',
  createdAt: '2026-10-09T10:00:01.000Z',
  data: {
    chargeId: 'ch_1',
    reference: 'tp_1',
    amount: 1000,
    currency: 'VND',
    status: 'SUCCEEDED',
    completedAt: '2026-10-09T10:00:01.000Z',
  },
};

describe('charge webhook metadata', () => {
  it('stays valid without metadata (backward compatible)', () => {
    expect(validateChargeWebhook(base).ok).toBe(true);
  });

  it('accepts string-to-string metadata and exposes it on the typed payload', () => {
    const result = validateChargeWebhook({ ...base, data: { ...base.data, metadata: { tenantId: 'acme' } } });
    expect(result.ok).toBe(true);
    expect(result.ok && result.payload.data.metadata).toEqual({ tenantId: 'acme' });
  });

  it.each([
    ['a non-string value', { tenantId: 7 }],
    ['an array', ['x']],
    ['a value over 200 characters', { tenantId: 'x'.repeat(201) }],
    ['more than 10 keys', Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']))],
  ])('rejects metadata that is %s', (_name, metadata) => {
    expect(validateChargeWebhook({ ...base, data: { ...base.data, metadata } }).ok).toBe(false);
  });
});
```

`services/payment/src/domain/metadata.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InvalidChargeError } from './errors.js';
import { EMPTY_METADATA, parseMetadata, parseStoredMetadata } from './metadata.js';

describe('parseMetadata', () => {
  it('treats undefined as empty', () => {
    expect(parseMetadata(undefined)).toBe(EMPTY_METADATA);
  });

  it('accepts string values and returns the keys sorted', () => {
    const parsed = parseMetadata({ tenantId: 'acme', a1: 'x' });
    expect(Object.keys(parsed)).toEqual(['a1', 'tenantId']);
    expect(parsed).toEqual({ a1: 'x', tenantId: 'acme' });
  });

  it('accepts exactly 10 keys, a 40-character key and a 200-character value', () => {
    const tenKeys = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v']));
    expect(() => parseMetadata(tenKeys)).not.toThrow();
    expect(() => parseMetadata({ [`a${'b'.repeat(39)}`]: 'v' })).not.toThrow();
    expect(() => parseMetadata({ k: 'x'.repeat(200) })).not.toThrow();
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', ['a']],
    ['11 keys', Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']))],
    ['a key starting with a digit', { '1a': 'v' }],
    ['a key with a dash', { 'a-b': 'v' }],
    ['a 41-character key', { [`a${'b'.repeat(40)}`]: 'v' }],
    ['a non-string value', { k: 1 }],
    ['a 201-character value', { k: 'x'.repeat(201) }],
  ])('rejects %s', (_name, raw) => {
    expect(() => parseMetadata(raw)).toThrow(InvalidChargeError);
  });
});

describe('parseStoredMetadata', () => {
  it('maps null to empty and parses stored JSON', () => {
    expect(parseStoredMetadata(null)).toEqual({});
    expect(parseStoredMetadata('{"tenantId":"acme"}')).toEqual({ tenantId: 'acme' });
  });
});
```

`services/payment/src/domain/webhook-event.metadata.test.ts`:
```ts
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { Charge } from './charge.js';
import { DEFAULT_SCENARIO } from './scenario.js';
import { WebhookEvent } from './webhook-event.js';

const now = new Date('2026-10-09T10:00:00.000Z');
const completed = (metadata?: Record<string, string>) =>
  Charge.create({
    id: 'ch_1',
    reference: 'tp_1',
    amount: Money.of(1000, 'VND'),
    scenario: DEFAULT_SCENARIO,
    now,
    ...(metadata ? { metadata } : {}),
  }).complete(now);

describe('WebhookEvent payload metadata', () => {
  it('includes data.metadata when the charge has metadata', () => {
    const event = WebhookEvent.forCharge(completed({ tenantId: 'acme' }), 'evt_1', now);
    expect(JSON.parse(event.toProps().payload).data.metadata).toEqual({ tenantId: 'acme' });
  });

  it('omits data.metadata entirely when the charge has none', () => {
    const event = WebhookEvent.forCharge(completed(), 'evt_1', now);
    expect(JSON.parse(event.toProps().payload).data).not.toHaveProperty('metadata');
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/contracts/src/webhook.metadata.test.ts services/payment/src/domain`
Expected: FAIL (thiếu `./metadata.js`, `data.metadata` chưa có trong schema, `Charge.create` chưa nhận `metadata`).

- [ ] **Step 3: Contract, domain**

Trong `packages/contracts/src/webhook.ts`, ngay sau dòng
```ts
        failureCode: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
```
thêm:
```ts
        metadata: {
          type: 'object',
          maxProperties: 10,
          additionalProperties: { type: 'string', maxLength: 200 },
        },
```

`services/payment/src/domain/metadata.ts`:
```ts
import { InvalidChargeError } from './errors.js';

export type Metadata = Readonly<Record<string, string>>;

export const EMPTY_METADATA: Metadata = {};
export const MAX_METADATA_KEYS = 10;
export const MAX_METADATA_VALUE_LENGTH = 200;

const KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/** Kiểm tra metadata do bên gọi gửi; trả về bản có khóa đã sắp xếp (dạng chuẩn để băm và lưu). */
export function parseMetadata(raw: unknown): Metadata {
  if (raw === undefined) return EMPTY_METADATA;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InvalidChargeError('metadata must be an object of string values');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new InvalidChargeError(`metadata allows at most ${MAX_METADATA_KEYS} keys`);
  }
  const parsed: Record<string, string> = {};
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!KEY.test(key)) {
      throw new InvalidChargeError(`metadata key "${key}" must match ${KEY.source}`);
    }
    if (typeof value !== 'string' || value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new InvalidChargeError(
        `metadata value for "${key}" must be a string of at most ${MAX_METADATA_VALUE_LENGTH} characters`,
      );
    }
    parsed[key] = value;
  }
  return Object.keys(parsed).length === 0 ? EMPTY_METADATA : parsed;
}

/** Đọc metadata đã lưu trong DB (JSON hoặc null). */
export function parseStoredMetadata(raw: string | null): Metadata {
  return raw === null ? EMPTY_METADATA : (JSON.parse(raw) as Metadata);
}

export const hasMetadata = (metadata: Metadata): boolean => Object.keys(metadata).length > 0;
```

Viết lại toàn bộ `services/payment/src/domain/charge.ts`:
```ts
import type { Money } from '@billing/money';
import { InvalidChargeError, StateTransitionError } from './errors.js';
import { EMPTY_METADATA, type Metadata } from './metadata.js';
import type { Scenario } from './scenario.js';

export const MAX_REFERENCE_LENGTH = 200;

export type ChargeStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface ChargeProps {
  readonly id: string;
  readonly reference: string;
  readonly amount: Money;
  readonly status: ChargeStatus;
  readonly failureCode: string | null;
  readonly scenario: Scenario;
  readonly metadata: Metadata;
  readonly dueAt: Date;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export class Charge {
  private constructor(private readonly props: ChargeProps) {}

  static create(input: {
    id: string;
    reference: string;
    amount: Money;
    scenario: Scenario;
    metadata?: Metadata;
    now: Date;
  }): Charge {
    if (input.reference.trim().length === 0 || input.reference.length > MAX_REFERENCE_LENGTH) {
      throw new InvalidChargeError(`reference must be 1..${MAX_REFERENCE_LENGTH} characters`);
    }
    if (!input.amount.isPositive()) {
      throw new InvalidChargeError('amount must be at least 1 minor unit');
    }
    const delayMs = (input.scenario.delaySeconds ?? 0) * 1000;
    return new Charge({
      id: input.id,
      reference: input.reference,
      amount: input.amount,
      status: 'PENDING',
      failureCode: null,
      scenario: input.scenario,
      metadata: input.metadata ?? EMPTY_METADATA,
      dueAt: new Date(input.now.getTime() + delayMs),
      createdAt: input.now,
      completedAt: null,
    });
  }

  static rehydrate(props: ChargeProps): Charge {
    return new Charge(props);
  }

  isDue(now: Date): boolean {
    return this.props.status === 'PENDING' && this.props.dueAt.getTime() <= now.getTime();
  }

  complete(now: Date): Charge {
    if (this.props.status !== 'PENDING') {
      throw new StateTransitionError(`charge ${this.props.id} is already ${this.props.status}`);
    }
    if (!this.isDue(now)) {
      throw new StateTransitionError(`charge ${this.props.id} is not due yet`);
    }
    const failureCode = this.props.scenario.fail;
    return new Charge({
      ...this.props,
      status: failureCode === null ? 'SUCCEEDED' : 'FAILED',
      failureCode,
      completedAt: now,
    });
  }

  toProps(): ChargeProps {
    return { ...this.props };
  }
}
```

Trong `services/payment/src/domain/webhook-event.ts`: thêm import `import { hasMetadata } from './metadata.js';` cùng nhóm import đầu file, và trong object `data` của `JSON.stringify`, ngay sau dòng
```ts
        ...(c.failureCode === null ? {} : { failureCode: c.failureCode }),
```
thêm
```ts
        ...(hasMetadata(c.metadata) ? { metadata: c.metadata } : {}),
```

- [ ] **Step 4: Chạy lại test domain và contract**

Run: `corepack pnpm exec vitest run packages/contracts services/payment/src/domain`
Expected: PASS (kể cả các test cũ của `charge.test.ts`, `webhook-event.test.ts`: `metadata` mặc định rỗng nên không đổi hành vi).

- [ ] **Step 5: Viết test thất bại (migration, application, route)**

Sửa `db/payment/migrations.integration.test.ts`: đổi dòng
```ts
    expect(await migrate(db, paymentMigrations)).toEqual(['001-init']);
```
thành
```ts
    expect(await migrate(db, paymentMigrations)).toEqual(['001-init', '002-metadata']);
```

`services/payment/src/application/create-charge.metadata.integration.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidChargeError } from '../domain/errors.js';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CreateCharge, type CreateChargeInput } from './create-charge.js';
import { IdempotencyConflictError } from './errors.js';
import { GetCharge } from './get-charge.js';

let h: Harness;
let createCharge: CreateCharge;
let getCharge: GetCharge;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  getCharge = new GetCharge({ uow: h.uow });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
});

const input = (overrides: Partial<CreateChargeInput> = {}): CreateChargeInput => ({
  idempotencyKey: 'key-1',
  amount: 1000,
  currency: 'VND',
  reference: 'tp_1',
  ...overrides,
});

describe('CreateCharge metadata', () => {
  it('stores metadata, echoes it in both views and persists it', async () => {
    const { body } = await createCharge.execute(input({ metadata: { tenantId: 'acme', k: 'v' } }));
    expect(body.metadata).toEqual({ k: 'v', tenantId: 'acme' });
    const viewed = await getCharge.execute(body.chargeId);
    expect(viewed.metadata).toEqual({ k: 'v', tenantId: 'acme' });
    const [row] = await h.db.selectFrom('charges').select('metadata').execute();
    expect(JSON.parse(row?.metadata ?? 'null')).toEqual({ k: 'v', tenantId: 'acme' });
  });

  it('omits metadata from the views when none was sent', async () => {
    const { body } = await createCharge.execute(input());
    expect(body).not.toHaveProperty('metadata');
    expect(await getCharge.execute(body.chargeId)).not.toHaveProperty('metadata');
  });

  it('replays for the same key and same metadata regardless of key order', async () => {
    const first = await createCharge.execute(input({ metadata: { b: '2', a: '1' } }));
    const replay = await createCharge.execute(input({ metadata: { a: '1', b: '2' } }));
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.body.chargeId).toBe(first.body.chargeId);
  });

  it('answers a conflict when the same key carries different metadata', async () => {
    await createCharge.execute(input({ metadata: { tenantId: 'acme' } }));
    await expect(createCharge.execute(input({ metadata: { tenantId: 'beta' } }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(createCharge.execute(input())).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('rejects invalid metadata and persists nothing', async () => {
    await expect(createCharge.execute(input({ metadata: { 'bad-key': 'v' } }))).rejects.toBeInstanceOf(
      InvalidChargeError,
    );
    expect(await h.db.selectFrom('charges').selectAll().execute()).toHaveLength(0);
  });
});
```

`services/payment/src/application/get-settlement.metadata.integration.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { GetSettlement } from './get-settlement.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let getSettlement: GetSettlement;

beforeAll(async () => {
  h = await createHarness('2026-10-10T10:00:00.000Z');
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
  getSettlement = new GetSettlement({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set('2026-10-10T10:00:00.000Z');
});

describe('GetSettlement metadata', () => {
  it('returns metadata on items that have it and omits it on the others', async () => {
    await createCharge.execute({
      idempotencyKey: 'a',
      amount: 1000,
      currency: 'VND',
      reference: 'with-meta',
      metadata: { tenantId: 'acme' },
    });
    await createCharge.execute({
      idempotencyKey: 'b',
      amount: 2000,
      currency: 'VND',
      reference: 'no-meta',
    });
    await completeDue.execute();
    h.clock.set('2026-10-11T12:00:00.000Z');

    const view = await getSettlement.execute({ date: '2026-10-10' });
    const byRef = new Map(view.items.map((item) => [item.reference, item]));
    expect(byRef.get('with-meta')?.metadata).toEqual({ tenantId: 'acme' });
    expect(byRef.get('no-meta')).not.toHaveProperty('metadata');
  });
});
```

`services/payment/src/interface/http/charges.metadata.route.test.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateChargeInput, CreateChargeResult } from '../../application/create-charge.js';
import { InvalidChargeError } from '../../domain/errors.js';
import { buildApp, type AppDependencies } from './app.js';
import { stubDeps } from './stub-deps.js';

const created: CreateChargeResult = {
  status: 202,
  replayed: false,
  responseTimeout: false,
  body: {
    chargeId: 'ch_1',
    reference: 'tp_1',
    amount: 1000,
    currency: 'VND',
    status: 'PENDING',
    createdAt: '2026-10-09T10:00:00.000Z',
  },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<AppDependencies>): Promise<FastifyInstance> {
  app = await buildApp(stubDeps(overrides));
  return app;
}

const post = (server: FastifyInstance, payload: object) =>
  server.inject({
    method: 'POST',
    url: '/charges',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    payload: JSON.stringify(payload),
  });

describe('POST /charges metadata', () => {
  it('forwards metadata untouched to the use case', async () => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(async () => created);
    const server = await start({ createCharge: { execute } });
    await post(server, { amount: 1000, currency: 'VND', reference: 'tp_1', metadata: { tenantId: 'acme' } });
    expect(execute.mock.calls[0]?.[0].metadata).toEqual({ tenantId: 'acme' });
  });

  it('passes no metadata when the field is absent', async () => {
    const execute = vi.fn<(input: CreateChargeInput) => Promise<CreateChargeResult>>(async () => created);
    const server = await start({ createCharge: { execute } });
    await post(server, { amount: 1000, currency: 'VND', reference: 'tp_1' });
    expect(execute.mock.calls[0]?.[0].metadata).toBeUndefined();
  });

  it('maps invalid metadata to 400 INVALID_REQUEST', async () => {
    const server = await start({
      createCharge: {
        execute: async () => {
          throw new InvalidChargeError('metadata key "x-y" must match ^[a-zA-Z]');
        },
      },
    });
    const res = await post(server, { amount: 1000, currency: 'VND', reference: 'tp_1', metadata: { 'x-y': 'v' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });
});
```

- [ ] **Step 6: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration create-charge.metadata get-settlement.metadata migrations && corepack pnpm exec vitest run services/payment/src/interface`
Expected: FAIL (thiếu migration `002`, `CreateChargeInput.metadata`, các view chưa có `metadata`).

- [ ] **Step 7: Migration, lưu trữ, use case, view, route**

`db/payment/002-metadata.ts`:
```ts
import { sql, type Kysely } from 'kysely';

/** Metadata do bên gọi gửi kèm charge (chuỗi JSON); null khi không có. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table charges add metadata nvarchar(max) null`.execute(db);
}
```

Viết lại toàn bộ `db/payment/migrations.ts`:
```ts
import type { Migration } from '@billing/database';
import * as init from './001-init.js';
import * as metadata from './002-metadata.js';

/** Tên migration quyết định thứ tự chạy; chỉ thêm mới, không sửa migration đã phát hành. */
export const paymentMigrations: Record<string, Migration> = {
  '001-init': init,
  '002-metadata': metadata,
};
```

Trong `services/payment/src/infrastructure/kysely/schema.ts`, trong `interface ChargesTable`, ngay sau dòng `scenario: string;` thêm:
```ts
  metadata: string | null;
```

Viết lại toàn bộ `services/payment/src/infrastructure/kysely/mappers.ts`:
```ts
import { dateTime, toSafeInteger } from '@billing/database';
import { Money, type Currency } from '@billing/money';
import type { Insertable, Selectable } from 'kysely';
import { Charge } from '../../domain/charge.js';
import type { ChargeStatus } from '../../domain/charge.js';
import { hasMetadata, parseStoredMetadata } from '../../domain/metadata.js';
import type { Scenario } from '../../domain/scenario.js';
import { WebhookEvent } from '../../domain/webhook-event.js';
import type { WebhookEventStatus, WebhookEventType } from '../../domain/webhook-event.js';
import type { ChargesTable, WebhookEventsTable } from './schema.js';

export function chargeToRow(charge: Charge): Insertable<ChargesTable> {
  const p = charge.toProps();
  return {
    id: p.id,
    reference: p.reference,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: p.status,
    failure_code: p.failureCode,
    scenario: JSON.stringify(p.scenario),
    metadata: hasMetadata(p.metadata) ? JSON.stringify(p.metadata) : null,
    due_at: dateTime(p.dueAt) as unknown as Date,
    created_at: dateTime(p.createdAt) as unknown as Date,
    completed_at: p.completedAt === null ? null : (dateTime(p.completedAt) as unknown as Date),
  };
}

export function rowToCharge(row: Selectable<ChargesTable>): Charge {
  return Charge.rehydrate({
    id: row.id,
    reference: row.reference,
    amount: Money.of(toSafeInteger(row.amount), row.currency as Currency),
    status: row.status as ChargeStatus,
    failureCode: row.failure_code,
    scenario: JSON.parse(row.scenario) as Scenario,
    metadata: parseStoredMetadata(row.metadata),
    dueAt: row.due_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

export function webhookToRow(event: WebhookEvent): Insertable<WebhookEventsTable> {
  const p = event.toProps();
  return {
    event_id: p.eventId,
    charge_id: p.chargeId,
    event_type: p.type,
    payload: p.payload,
    status: p.status,
    attempts: p.attempts,
    next_attempt_at:
      p.nextAttemptAt === null ? null : (dateTime(p.nextAttemptAt) as unknown as Date),
    send_twice: p.sendTwice,
    created_at: dateTime(p.createdAt) as unknown as Date,
    delivered_at: p.deliveredAt === null ? null : (dateTime(p.deliveredAt) as unknown as Date),
  };
}

export function rowToWebhook(row: Selectable<WebhookEventsTable>): WebhookEvent {
  return WebhookEvent.rehydrate({
    eventId: row.event_id,
    chargeId: row.charge_id,
    type: row.event_type as WebhookEventType,
    payload: row.payload,
    status: row.status as WebhookEventStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    sendTwice: row.send_twice,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  });
}
```

Trong `services/payment/src/infrastructure/kysely/charge.repository.ts`, trong câu `select top (${limit}) ...` của `lockDue`, đổi dòng cột
```
      select top (${limit}) id, reference, amount, currency, status, failure_code, scenario,
```
thành
```
      select top (${limit}) id, reference, amount, currency, status, failure_code, scenario, metadata,
```
(đặt đúng `metadata` trước `due_at`; nếu Prettier/định dạng khác đi thì giữ nguyên cấu trúc, chỉ thêm cột `metadata` vào danh sách cột).

Viết lại toàn bộ `services/payment/src/application/views.ts`:
```ts
import type { Charge, ChargeStatus } from '../domain/charge.js';
import { hasMetadata, type Metadata } from '../domain/metadata.js';

export interface ChargeCreatedView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: 'PENDING';
  metadata?: Metadata;
  createdAt: string;
}

export interface ChargeView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: ChargeStatus;
  failureCode?: string;
  metadata?: Metadata;
  createdAt: string;
  completedAt?: string;
}

export function toCreatedView(charge: Charge): ChargeCreatedView {
  const p = charge.toProps();
  return {
    chargeId: p.id,
    reference: p.reference,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: 'PENDING',
    ...(hasMetadata(p.metadata) ? { metadata: p.metadata } : {}),
    createdAt: p.createdAt.toISOString(),
  };
}

export function toChargeView(charge: Charge): ChargeView {
  const p = charge.toProps();
  return {
    chargeId: p.id,
    reference: p.reference,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: p.status,
    ...(p.failureCode === null ? {} : { failureCode: p.failureCode }),
    ...(hasMetadata(p.metadata) ? { metadata: p.metadata } : {}),
    createdAt: p.createdAt.toISOString(),
    ...(p.completedAt === null ? {} : { completedAt: p.completedAt.toISOString() }),
  };
}
```

Viết lại toàn bộ `services/payment/src/application/create-charge.ts`:
```ts
import { createHash } from 'node:crypto';
import { Money, type Currency } from '@billing/money';
import { Charge } from '../domain/charge.js';
import { hasMetadata, parseMetadata } from '../domain/metadata.js';
import { parseScenario } from '../domain/scenario.js';
import { DuplicateKeyError, IdempotencyConflictError } from './errors.js';
import type { Clock, IdGenerator, StoredResponse, UnitOfWork } from './ports.js';
import { toCreatedView, type ChargeCreatedView } from './views.js';

export interface CreateChargeInput {
  idempotencyKey: string;
  amount: number;
  currency: string;
  reference: string;
  simulate?: string | undefined;
  /** Chưa kiểm tra: use case tự kiểm bằng `parseMetadata` (ném `InvalidChargeError`). */
  metadata?: unknown;
}

export interface CreateChargeResult {
  status: number;
  body: ChargeCreatedView;
  replayed: boolean;
  /** Chỉ true ở lần tạo đầu tiên; lần replay luôn trả ngay để client có lối thoát. */
  responseTimeout: boolean;
}

const ACCEPTED = 202;

export class CreateCharge {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator }) {}

  async execute(input: CreateChargeInput): Promise<CreateChargeResult> {
    const scenario = parseScenario(input.simulate);
    const amount = Money.of(input.amount, input.currency as Currency);
    const metadata = parseMetadata(input.metadata);
    // Băm nội dung đã chuẩn hóa: thứ tự token trong X-Simulate và thứ tự khóa metadata không làm đổi hash.
    // `metadata` chỉ góp mặt khi không rỗng để request cũ (không có metadata) giữ nguyên hash.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          amount: amount.amount,
          currency: amount.currency,
          reference: input.reference,
          scenario,
          ...(hasMetadata(metadata) ? { metadata } : {}),
        }),
      )
      .digest('hex');

    const attempt = (): Promise<CreateChargeResult> =>
      this.deps.uow.run(async ({ charges, idempotency }) => {
        const existing = await idempotency.find(input.idempotencyKey);
        if (existing) return this.replay(existing, requestHash);

        const now = this.deps.clock.now();
        const charge = Charge.create({
          id: this.deps.ids.chargeId(),
          reference: input.reference,
          amount,
          scenario,
          metadata,
          now,
        });
        const body = toCreatedView(charge);
        await charges.insert(charge);
        await idempotency.save({
          key: input.idempotencyKey,
          requestHash,
          responseStatus: ACCEPTED,
          responseBody: JSON.stringify(body),
          chargeId: body.chargeId,
          createdAt: now,
        });
        return {
          status: ACCEPTED,
          body,
          replayed: false,
          responseTimeout: scenario.responseTimeout,
        };
      });

    try {
      return await attempt();
    } catch (error) {
      // Hai request đồng thời cùng key: bên thua vấp khóa chính; giao dịch của nó đã rollback,
      // chạy lại một lần sẽ thấy bản ghi của bên thắng và trả về replay.
      if (error instanceof DuplicateKeyError) return await attempt();
      throw error;
    }
  }

  private replay(existing: StoredResponse, requestHash: string): CreateChargeResult {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key "${existing.key}" was already used with different content`,
      );
    }
    return {
      status: existing.responseStatus,
      body: JSON.parse(existing.responseBody) as ChargeCreatedView,
      replayed: true,
      responseTimeout: false,
    };
  }
}
```

Trong `services/payment/src/application/get-settlement.ts`:
- thêm import `import { hasMetadata, type Metadata } from '../domain/metadata.js';` cùng nhóm import đầu file;
- trong `interface SettlementItem`, ngay sau dòng `failureCode?: string;` thêm `metadata?: Metadata;`;
- trong hàm map `items`, ngay sau dòng
  ```ts
        ...(p.failureCode === null ? {} : { failureCode: p.failureCode }),
  ```
  thêm
  ```ts
        ...(hasMetadata(p.metadata) ? { metadata: p.metadata } : {}),
  ```

Trong `services/payment/src/interface/http/charges.route.ts`:
- đổi `const { amount, currency, reference } = body as Record<string, unknown>;` thành `const { amount, currency, reference, metadata } = body as Record<string, unknown>;`
- trong lời gọi `options.createCharge.execute({ ... })`, ngay sau dòng `reference,` thêm `metadata,` (giá trị `undefined` khi client không gửi).

- [ ] **Step 8: Chạy toàn bộ kiểm tra**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test
corepack pnpm test:integration
```
Expected: PASS toàn bộ — gồm các test cũ của payment (không có metadata ⇒ hành vi cũ giữ nguyên, hash không đổi) và các test mới. Nếu một test cũ báo thiếu `metadata` trong `toProps()` so sánh, đó là chỗ `ChargeProps` mới: cập nhật đúng test đó để mong đợi `metadata: {}`; không nới lỏng assertion khác.

- [ ] **Step 9: Commit**

```bash
git add -A packages/contracts services/payment db
git commit -m "feat(payment): accept, store and echo charge metadata (webhook, views, settlements)"
```

### Task 3: Wallet — cấu hình, `TenantId`, `CustomerId`, `TenantRegistry`, lỗi

**Files:**
- Create: `services/wallet/src/domain/errors.ts`, `domain/tenant-id.ts`, `domain/customer-id.ts`, `application/errors.ts`, `application/ports.ts`, `infrastructure/tenant-registry.ts`, `services/wallet/src/config.ts`, `services/wallet/.env.example`
- Modify: `services/wallet/package.json` (qua pnpm)
- Test: `services/wallet/src/domain/tenant-id.test.ts`, `domain/customer-id.test.ts`, `infrastructure/tenant-registry.test.ts`, `config.test.ts`

**Interfaces:**
- Produces:
  - Lỗi domain (đều `extends Error`): `InvalidTenantError`, `InvalidCustomerError`, `InvalidTopupError`, `InvalidLedgerTransactionError`, `InsufficientFundsError`, `LedgerInvariantError`, `StateTransitionError`
  - Lỗi application (đều `extends Error`): `MissingTenantError`, `UnknownTenantError`, `MissingCustomerError`, `WalletNotFoundError`, `WalletCurrencyConflictError`, `TopupNotFoundError`, `IdempotencyConflictError`, `InvalidQueryError`, `DuplicateKeyError`
  - `class TenantId { readonly value: string; static parse(raw: string): TenantId; toString(): string; equals(other: TenantId): boolean }` (regex `^[a-z][a-z0-9-]{0,39}$`, ném `InvalidTenantError`)
  - `class CustomerId { readonly value: string; static parse(raw: string): CustomerId }` (regex `^[A-Za-z0-9_-]{1,64}$`, ném `InvalidCustomerError`)
  - `interface TenantRegistry { resolve(raw: string | undefined): TenantId; all(): readonly TenantId[] }` trong `application/ports.ts` (sẽ được bổ sung thêm port ở Task 6); `class ConfigTenantRegistry implements TenantRegistry` (`constructor(tenants: readonly TenantId[])`): thiếu/blank → `MissingTenantError`; sai dạng hoặc ngoài danh sách → `UnknownTenantError`
  - `interface WalletConfig { port: number; database: DatabaseConfig; tenants: TenantId[]; payment: { baseUrl: string; webhookSecret: string; timeoutMs: number }; topupBackoffSeconds: number[]; workerIntervalMs: number }`, `loadConfig(env: NodeJS.ProcessEnv): WalletConfig` (ném `ConfigError` liệt kê mọi vấn đề **theo thứ tự**: biến DB, `WALLET_TENANTS`, `PAYMENT_BASE_URL`, `PAYMENT_WEBHOOK_SECRET`, `TOPUP_SUBMIT_BACKOFF`, `PORT`, `PAYMENT_TIMEOUT_MS`, `WORKER_INTERVAL_MS`; `PAYMENT_BASE_URL` được cắt dấu `/` cuối)

- [ ] **Step 1: Phụ thuộc**

```bash
corepack pnpm --filter @billing/wallet-service add kysely @billing/database@workspace:* @billing/money@workspace:* @billing/contracts@workspace:* @billing/runtime@workspace:*
corepack pnpm --filter @billing/wallet-service add -D @billing/testing@workspace:*
```
Expected: không lỗi.

- [ ] **Step 2: Viết test thất bại**

`services/wallet/src/domain/tenant-id.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { InvalidTenantError } from './errors.js';
import { TenantId } from './tenant-id.js';

describe('TenantId.parse', () => {
  it.each(['acme', 'a', 'tenant-1', 'a'.repeat(40), 'x9-y9'])('accepts %s', (raw) => {
    expect(TenantId.parse(raw).value).toBe(raw);
    expect(TenantId.parse(raw).toString()).toBe(raw);
  });

  it.each([
    '',
    ' acme',
    'Acme',
    '1acme',
    '-acme',
    'ac_me',
    'ac me',
    'ac/me',
    'ac]me',
    'a'.repeat(41),
    'acme\n',
  ])('rejects %j', (raw) => {
    expect(() => TenantId.parse(raw)).toThrow(InvalidTenantError);
  });

  it('compares by value', () => {
    expect(TenantId.parse('acme').equals(TenantId.parse('acme'))).toBe(true);
    expect(TenantId.parse('acme').equals(TenantId.parse('beta'))).toBe(false);
  });
});
```

`services/wallet/src/domain/customer-id.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CustomerId } from './customer-id.js';
import { InvalidCustomerError } from './errors.js';

describe('CustomerId.parse', () => {
  it.each(['c1', 'C_1-x', '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01', 'a'.repeat(64)])('accepts %s', (raw) => {
    expect(CustomerId.parse(raw).value).toBe(raw);
  });

  it.each(['', ' c1', 'c 1', 'c:1', 'c/1', 'a'.repeat(65), 'c1\n'])('rejects %j', (raw) => {
    expect(() => CustomerId.parse(raw)).toThrow(InvalidCustomerError);
  });
});
```

`services/wallet/src/infrastructure/tenant-registry.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { MissingTenantError, UnknownTenantError } from '../application/errors.js';
import { TenantId } from '../domain/tenant-id.js';
import { ConfigTenantRegistry } from './tenant-registry.js';

const registry = new ConfigTenantRegistry([TenantId.parse('acme'), TenantId.parse('beta')]);

describe('ConfigTenantRegistry', () => {
  it('resolves configured tenants', () => {
    expect(registry.resolve('acme').value).toBe('acme');
    expect(registry.resolve('beta').value).toBe('beta');
  });

  it('lists every configured tenant', () => {
    expect(registry.all().map((t) => t.value)).toEqual(['acme', 'beta']);
  });

  it.each([undefined, '', '   '])('treats %j as a missing tenant', (raw) => {
    expect(() => registry.resolve(raw)).toThrow(MissingTenantError);
  });

  it.each(['gamma', 'ACME', 'acme ', 'a/b', '1x'])('treats %j as an unknown tenant', (raw) => {
    expect(() => registry.resolve(raw)).toThrow(UnknownTenantError);
  });
});
```

`services/wallet/src/config.test.ts`:
```ts
import { ConfigError } from '@billing/database';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const minimal = {
  WALLET_DB_HOST: 'db',
  WALLET_DB_NAME: 'billing_wallet',
  WALLET_DB_USER: 'u',
  WALLET_DB_PASSWORD: 'p',
  WALLET_TENANTS: 'acme,beta',
  PAYMENT_BASE_URL: 'http://payment:3002/',
  PAYMENT_WEBHOOK_SECRET: 'whsec_x',
};

const problemsOf = (env: NodeJS.ProcessEnv): string[] => {
  try {
    loadConfig(env);
  } catch (error) {
    return (error as ConfigError).problems;
  }
  return [];
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(minimal);
    expect(config).toMatchObject({
      port: 3001,
      database: { host: 'db', port: 1433, database: 'billing_wallet', user: 'u', password: 'p' },
      payment: { baseUrl: 'http://payment:3002', webhookSecret: 'whsec_x', timeoutMs: 5000 },
      topupBackoffSeconds: [1, 5, 30, 120, 600],
      workerIntervalMs: 500,
    });
    expect(config.tenants.map((t) => t.value)).toEqual(['acme', 'beta']);
  });

  it('reads overrides and trims spaces around tenants', () => {
    const config = loadConfig({
      ...minimal,
      WALLET_TENANTS: ' acme , beta',
      PORT: '4001',
      WALLET_DB_PORT: '14333',
      PAYMENT_TIMEOUT_MS: '250',
      TOPUP_SUBMIT_BACKOFF: '2, 4',
      WORKER_INTERVAL_MS: '50',
    });
    expect(config).toMatchObject({
      port: 4001,
      database: { port: 14333 },
      payment: { timeoutMs: 250 },
      topupBackoffSeconds: [2, 4],
      workerIntervalMs: 50,
    });
    expect(config.tenants.map((t) => t.value)).toEqual(['acme', 'beta']);
  });

  it('refuses to start without the required settings and lists them all, in a fixed order', () => {
    expect(problemsOf({})).toEqual([
      'WALLET_DB_HOST is required',
      'WALLET_DB_NAME is required',
      'WALLET_DB_USER is required',
      'WALLET_DB_PASSWORD is required',
      'WALLET_TENANTS is required',
      'PAYMENT_BASE_URL is required',
      'PAYMENT_WEBHOOK_SECRET is required',
    ]);
  });

  it('has no default for the secret and treats blank as missing', () => {
    expect(problemsOf({ ...minimal, PAYMENT_WEBHOOK_SECRET: '  ' })).toEqual([
      'PAYMENT_WEBHOOK_SECRET is required',
    ]);
  });

  it.each(['ftp://x', 'not a url', 'payment:3002'])('rejects PAYMENT_BASE_URL %j', (url) => {
    expect(problemsOf({ ...minimal, PAYMENT_BASE_URL: url })).toEqual([
      'PAYMENT_BASE_URL must be an absolute http(s) URL',
    ]);
  });

  it('rejects an invalid tenant id and duplicate tenants', () => {
    expect(problemsOf({ ...minimal, WALLET_TENANTS: 'acme,Bad_Tenant' })).toEqual([
      'WALLET_TENANTS contains an invalid tenant id "Bad_Tenant"',
    ]);
    expect(problemsOf({ ...minimal, WALLET_TENANTS: 'acme,acme' })).toEqual([
      'WALLET_TENANTS contains duplicate tenant "acme"',
    ]);
    expect(problemsOf({ ...minimal, WALLET_TENANTS: ' , ' })).toEqual(['WALLET_TENANTS is required']);
  });

  it.each(['', '1,a', '0', '-1', '1.5', '1,,2'])('handles TOPUP_SUBMIT_BACKOFF %j', (value) => {
    const problems = problemsOf({ ...minimal, TOPUP_SUBMIT_BACKOFF: value });
    // Chuỗi rỗng được coi như không đặt (dùng mặc định).
    expect(problems).toEqual(
      value === ''
        ? []
        : ['TOPUP_SUBMIT_BACKOFF must be a comma-separated list of positive integers (seconds)'],
    );
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PAYMENT_TIMEOUT_MS', '0'],
    ['PAYMENT_TIMEOUT_MS', '999999'],
    ['WORKER_INTERVAL_MS', '0'],
    ['WORKER_INTERVAL_MS', 'abc'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf({ ...minimal, [name]: value })).toEqual([
      expect.stringContaining(`${name} must be an integer`),
    ]);
  });

  it('reports a bad database port together with the other problems', () => {
    expect(problemsOf({ ...minimal, WALLET_DB_PORT: 'x', PAYMENT_WEBHOOK_SECRET: '' })).toEqual([
      'WALLET_DB_PORT must be an integer in 1..65535',
      'PAYMENT_WEBHOOK_SECRET is required',
    ]);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet`
Expected: FAIL (không resolve được các module mới).

- [ ] **Step 4: Cài code**

`services/wallet/src/domain/errors.ts`:
```ts
export class InvalidTenantError extends Error {
  override name = 'InvalidTenantError';
}

export class InvalidCustomerError extends Error {
  override name = 'InvalidCustomerError';
}

export class InvalidTopupError extends Error {
  override name = 'InvalidTopupError';
}

export class InvalidLedgerTransactionError extends Error {
  override name = 'InvalidLedgerTransactionError';
}

/** Ví không đủ số dư (số dư sau giao dịch sẽ âm). */
export class InsufficientFundsError extends Error {
  override name = 'InsufficientFundsError';
}

/** Vi phạm bất biến sổ cái (ví dụ GATEWAY dương, khác đồng tiền). */
export class LedgerInvariantError extends Error {
  override name = 'LedgerInvariantError';
}

export class StateTransitionError extends Error {
  override name = 'StateTransitionError';
}
```

`services/wallet/src/domain/tenant-id.ts`:
```ts
import { InvalidTenantError } from './errors.js';

const TENANT = /^[a-z][a-z0-9-]{0,39}$/;

/** Định danh tenant đã được kiểm tra. Chỉ tạo được qua `parse`, nên mọi nơi nhận `TenantId` đều an toàn khi dựng tên schema. */
export class TenantId {
  private constructor(readonly value: string) {}

  static parse(raw: string): TenantId {
    if (!TENANT.test(raw)) {
      throw new InvalidTenantError(`tenant id must match ${TENANT.source}`);
    }
    return new TenantId(raw);
  }

  equals(other: TenantId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
```

`services/wallet/src/domain/customer-id.ts`:
```ts
import { InvalidCustomerError } from './errors.js';

const CUSTOMER = /^[A-Za-z0-9_-]{1,64}$/;

export class CustomerId {
  private constructor(readonly value: string) {}

  static parse(raw: string): CustomerId {
    if (!CUSTOMER.test(raw)) {
      throw new InvalidCustomerError(`customer id must match ${CUSTOMER.source}`);
    }
    return new CustomerId(raw);
  }
}
```

`services/wallet/src/application/errors.ts`:
```ts
export class MissingTenantError extends Error {
  override name = 'MissingTenantError';
}

export class UnknownTenantError extends Error {
  override name = 'UnknownTenantError';
}

export class MissingCustomerError extends Error {
  override name = 'MissingCustomerError';
}

export class WalletNotFoundError extends Error {
  override name = 'WalletNotFoundError';
}

export class WalletCurrencyConflictError extends Error {
  override name = 'WalletCurrencyConflictError';
}

export class TopupNotFoundError extends Error {
  override name = 'TopupNotFoundError';
}

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
}

export class InvalidQueryError extends Error {
  override name = 'InvalidQueryError';
}

/** Do repository ném khi vi phạm khóa duy nhất (idempotency key, business key, inbox, ví trùng). */
export class DuplicateKeyError extends Error {
  override name = 'DuplicateKeyError';
}
```

`services/wallet/src/application/ports.ts`:
```ts
import type { TenantId } from '../domain/tenant-id.js';

export interface TenantRegistry {
  /** Biến chuỗi thô (header, metadata) thành `TenantId` hợp lệ và có trong cấu hình. */
  resolve(raw: string | undefined): TenantId;
  all(): readonly TenantId[];
}
```

`services/wallet/src/infrastructure/tenant-registry.ts`:
```ts
import { MissingTenantError, UnknownTenantError } from '../application/errors.js';
import type { TenantRegistry } from '../application/ports.js';
import { InvalidTenantError } from '../domain/errors.js';
import { TenantId } from '../domain/tenant-id.js';

export class ConfigTenantRegistry implements TenantRegistry {
  readonly #byValue: Map<string, TenantId>;

  constructor(private readonly tenants: readonly TenantId[]) {
    this.#byValue = new Map(tenants.map((tenant) => [tenant.value, tenant]));
  }

  resolve(raw: string | undefined): TenantId {
    if (raw === undefined || raw.trim() === '') {
      throw new MissingTenantError('tenant is required');
    }
    let parsed: TenantId;
    try {
      parsed = TenantId.parse(raw);
    } catch (error) {
      if (error instanceof InvalidTenantError) throw new UnknownTenantError('unknown tenant');
      throw error;
    }
    const known = this.#byValue.get(parsed.value);
    if (!known) throw new UnknownTenantError('unknown tenant');
    return known;
  }

  all(): readonly TenantId[] {
    return this.tenants;
  }
}
```

`services/wallet/src/config.ts`:
```ts
import { ConfigError, databaseConfigFromEnv, type DatabaseConfig } from '@billing/database';
import { InvalidTenantError } from './domain/errors.js';
import { TenantId } from './domain/tenant-id.js';

export interface WalletConfig {
  port: number;
  database: DatabaseConfig;
  tenants: TenantId[];
  payment: { baseUrl: string; webhookSecret: string; timeoutMs: number };
  topupBackoffSeconds: number[];
  workerIntervalMs: number;
}

const DEFAULT_BACKOFF = '1,5,30,120,600';

/** Đọc cấu hình từ môi trường; thiếu hoặc sai thì ném ConfigError liệt kê mọi vấn đề cùng lúc. */
export function loadConfig(env: NodeJS.ProcessEnv): WalletConfig {
  const problems: string[] = [];

  let database: DatabaseConfig | undefined;
  try {
    database = databaseConfigFromEnv('WALLET_DB', env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }

  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer in ${min}..${max}`);
      return fallback;
    }
    return value;
  };

  // WALLET_TENANTS
  const tenants: TenantId[] = [];
  const rawTenants = required('WALLET_TENANTS');
  if (rawTenants !== '') {
    const parts = rawTenants
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length === 0) {
      problems.push('WALLET_TENANTS is required');
    }
    const seen = new Set<string>();
    for (const part of parts) {
      try {
        const tenant = TenantId.parse(part);
        if (seen.has(tenant.value)) {
          problems.push(`WALLET_TENANTS contains duplicate tenant "${tenant.value}"`);
          continue;
        }
        seen.add(tenant.value);
        tenants.push(tenant);
      } catch (error) {
        if (!(error instanceof InvalidTenantError)) throw error;
        problems.push(`WALLET_TENANTS contains an invalid tenant id "${part}"`);
      }
    }
  }

  // PAYMENT_BASE_URL
  let baseUrl = required('PAYMENT_BASE_URL');
  if (baseUrl !== '') {
    let valid = false;
    try {
      const parsed = new URL(baseUrl);
      valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      valid = false;
    }
    if (valid) baseUrl = baseUrl.replace(/\/+$/, '');
    else problems.push('PAYMENT_BASE_URL must be an absolute http(s) URL');
  }

  const webhookSecret = required('PAYMENT_WEBHOOK_SECRET');

  const rawBackoff = env.TOPUP_SUBMIT_BACKOFF;
  const backoffText =
    rawBackoff === undefined || rawBackoff.trim() === '' ? DEFAULT_BACKOFF : rawBackoff;
  const backoffParts = backoffText.split(',').map((part) => part.trim());
  const topupBackoffSeconds = backoffParts.every((part) => /^[1-9]\d{0,5}$/.test(part))
    ? backoffParts.map(Number)
    : undefined;
  if (topupBackoffSeconds === undefined) {
    problems.push('TOPUP_SUBMIT_BACKOFF must be a comma-separated list of positive integers (seconds)');
  }

  const port = integer('PORT', 3001, 1, 65535);
  const timeoutMs = integer('PAYMENT_TIMEOUT_MS', 5000, 1, 120_000);
  const workerIntervalMs = integer('WORKER_INTERVAL_MS', 500, 1, 3_600_000);

  if (problems.length > 0 || database === undefined || topupBackoffSeconds === undefined) {
    throw new ConfigError(problems);
  }
  return {
    port,
    database,
    tenants,
    payment: { baseUrl, webhookSecret, timeoutMs },
    topupBackoffSeconds,
    workerIntervalMs,
  };
}
```

`services/wallet/.env.example`:
```
# Kết nối SQL Server (database billing_wallet đã được tạo bởi deploy/compose.billing.yml)
WALLET_DB_HOST=
WALLET_DB_PORT=1433
WALLET_DB_NAME=billing_wallet
WALLET_DB_USER=billing_wallet_app
WALLET_DB_PASSWORD=

# Tài khoản có quyền db_owner chỉ dùng cho `corepack pnpm db:migrate:wallet` (không dùng khi chạy service)
WALLET_MIGRATOR_DB_USER=
WALLET_MIGRATOR_DB_PASSWORD=

# Các tenant được phục vụ (ngăn cách bằng dấu phẩy); mỗi tenant khớp ^[a-z][a-z0-9-]{0,39}$
WALLET_TENANTS=

# Payment: địa chỉ gốc và khóa HMAC kiểm chữ ký webhook (không có giá trị mặc định)
PAYMENT_BASE_URL=
PAYMENT_WEBHOOK_SECRET=

# Tùy chọn (giá trị mặc định ghi bên cạnh)
PORT=3001
PAYMENT_TIMEOUT_MS=5000
TOPUP_SUBMIT_BACKOFF=1,5,30,120,600
WORKER_INTERVAL_MS=500
```

- [ ] **Step 5: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run services/wallet && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS. Nếu một ca của `config.test.ts` lệch thứ tự `problems`, đối chiếu với thứ tự cố định đã nêu ở **Interfaces**; không đổi test cho khớp một thứ tự khác.

- [ ] **Step 6: Commit**

```bash
git add -A services/wallet pnpm-lock.yaml
git commit -m "feat(wallet): add tenant/customer identifiers, tenant registry, errors and env config"
```

---

### Task 4: Wallet domain — `Account`, `LedgerTransaction`, `Topup`

**Files:**
- Create: `services/wallet/src/domain/account.ts`, `domain/ledger-transaction.ts`, `domain/topup.ts`
- Test: `services/wallet/src/domain/account.test.ts`, `domain/ledger-transaction.test.ts`, `domain/topup.test.ts`

**Interfaces:**
- Consumes: `CustomerId`, các lỗi domain (Task 3); `Money`, `Currency` từ `@billing/money`.
- Produces:
  - `type AccountKind = 'WALLET' | 'GATEWAY' | 'MERCHANT'`; `interface AccountProps { readonly id: string; readonly kind: AccountKind; readonly customerId: string | null; readonly currency: Currency; readonly balance: Money; readonly createdAt: Date }`
  - `class Account`: `static walletId(customerId: CustomerId): string` (`wallet:<id>`), `static systemId(kind: 'GATEWAY' | 'MERCHANT', currency: Currency): string` (`system:<KIND>:<CUR>`), `static openWallet(input: { customerId: CustomerId; currency: Currency; now: Date }): Account` (số dư 0), `static rehydrate(props: AccountProps): Account`, `apply(delta: Money): Account` (ném `LedgerInvariantError` nếu khác đồng tiền; ví âm → `InsufficientFundsError`; `GATEWAY` dương → `LedgerInvariantError`; `MERCHANT` âm → `LedgerInvariantError`), `toProps(): AccountProps`
  - `interface LedgerEntry { readonly accountId: string; readonly amount: Money }`; `type LedgerTransactionKind = 'TOPUP'`; `interface LedgerTransactionProps { readonly id: string; readonly businessKey: string; readonly kind: LedgerTransactionKind; readonly entries: readonly LedgerEntry[]; readonly createdAt: Date }`
  - `class LedgerTransaction`: `static create(input: { id: string; businessKey: string; kind: LedgerTransactionKind; entries: readonly LedgerEntry[]; now: Date }): LedgerTransaction` (ném `InvalidLedgerTransactionError`: `businessKey` 1..200 ký tự; ≥ 2 dòng; cùng đồng tiền; mỗi dòng khác 0; các `accountId` khác nhau; tổng bằng 0), `static topup(input: { id: string; topupId: string; walletAccountId: string; gatewayAccountId: string; amount: Money; now: Date }): LedgerTransaction` (`businessKey = topup:<topupId>`; dòng ví `+amount`, dòng gateway `−amount`; `amount` phải dương), `toProps(): LedgerTransactionProps`
  - `type TopupStatus = 'REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED'`; `interface TopupProps { readonly id: string; readonly customerId: string; readonly accountId: string; readonly amount: Money; readonly status: TopupStatus; readonly chargeId: string | null; readonly failureCode: string | null; readonly attempts: number; readonly nextAttemptAt: Date | null; readonly createdAt: Date; readonly completedAt: Date | null }`
  - `class Topup`: `static request(input: { id: string; customerId: CustomerId; accountId: string; amount: Money; now: Date }): Topup` (`REQUESTED`, `attempts 0`, `nextAttemptAt = now`; amount không dương → `InvalidTopupError`), `static rehydrate(props)`, `isDue(now): boolean` (`REQUESTED` và `nextAttemptAt <= now`), `claim(now, leaseSeconds): Topup` (chỉ từ `REQUESTED`; đẩy `nextAttemptAt`, không tính lần thử), `recordSubmitted(chargeId): Topup` (`REQUESTED → PENDING`, `attempts + 1`, `nextAttemptAt = null`), `recordRejected(now): Topup` (`REQUESTED → FAILED` `PAYMENT_REJECTED`, `attempts + 1`), `recordUnavailable(now, backoffSeconds: readonly number[]): Topup` (`attempts + 1`; nếu `backoffSeconds[attempts-1]` tồn tại thì vẫn `REQUESTED` và hẹn lại sau số giây đó, ngược lại `FAILED` `PAYMENT_UNAVAILABLE` + `completedAt`), `applySucceeded(chargeId, now): Topup` (từ `REQUESTED`/`PENDING`, hoặc từ `FAILED` **chỉ khi** `failureCode === 'PAYMENT_UNAVAILABLE'`; kết quả `SUCCEEDED`, `chargeId`, `nextAttemptAt = null`, `completedAt = now`), `applyFailed(failureCode, chargeId, now): Topup` (chỉ từ `REQUESTED`/`PENDING` → `FAILED`), `toProps()`; mọi chuyển trạng thái sai ném `StateTransitionError`

- [ ] **Step 1: Viết test thất bại**

`services/wallet/src/domain/account.test.ts`:
```ts
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { Account, type AccountProps } from './account.js';
import { CustomerId } from './customer-id.js';
import { InsufficientFundsError, LedgerInvariantError } from './errors.js';

const now = new Date('2026-10-10T10:00:00.000Z');

describe('Account ids', () => {
  it('derives deterministic ids', () => {
    expect(Account.walletId(CustomerId.parse('c1'))).toBe('wallet:c1');
    expect(Account.systemId('GATEWAY', 'VND')).toBe('system:GATEWAY:VND');
    expect(Account.systemId('MERCHANT', 'USD')).toBe('system:MERCHANT:USD');
  });
});

describe('Account.openWallet', () => {
  it('opens an empty wallet in the given currency', () => {
    const wallet = Account.openWallet({ customerId: CustomerId.parse('c1'), currency: 'VND', now });
    expect(wallet.toProps()).toEqual({
      id: 'wallet:c1',
      kind: 'WALLET',
      customerId: 'c1',
      currency: 'VND',
      balance: Money.zero('VND'),
      createdAt: now,
    });
  });
});

const rehydrate = (kind: AccountProps['kind'], balance: number, currency: 'VND' | 'USD' = 'VND') =>
  Account.rehydrate({
    id: kind === 'WALLET' ? 'wallet:c1' : `system:${kind}:${currency}`,
    kind,
    customerId: kind === 'WALLET' ? 'c1' : null,
    currency,
    balance: Money.of(balance, currency),
    createdAt: now,
  });

describe('Account.apply', () => {
  it('credits and debits a wallet but never lets it go negative', () => {
    const wallet = rehydrate('WALLET', 100);
    expect(wallet.apply(Money.of(50, 'VND')).toProps().balance.amount).toBe(150);
    expect(wallet.apply(Money.of(-100, 'VND')).toProps().balance.amount).toBe(0);
    expect(() => wallet.apply(Money.of(-101, 'VND'))).toThrow(InsufficientFundsError);
  });

  it('keeps the gateway account at or below zero', () => {
    const gateway = rehydrate('GATEWAY', -100);
    expect(gateway.apply(Money.of(-50, 'VND')).toProps().balance.amount).toBe(-150);
    expect(gateway.apply(Money.of(100, 'VND')).toProps().balance.amount).toBe(0);
    expect(() => gateway.apply(Money.of(101, 'VND'))).toThrow(LedgerInvariantError);
  });

  it('keeps the merchant account at or above zero', () => {
    const merchant = rehydrate('MERCHANT', 10);
    expect(merchant.apply(Money.of(-10, 'VND')).toProps().balance.amount).toBe(0);
    expect(() => merchant.apply(Money.of(-11, 'VND'))).toThrow(LedgerInvariantError);
  });

  it('rejects a delta in another currency', () => {
    expect(() => rehydrate('WALLET', 100).apply(Money.of(1, 'USD'))).toThrow(LedgerInvariantError);
  });

  it('is immutable', () => {
    const wallet = rehydrate('WALLET', 100);
    wallet.apply(Money.of(50, 'VND'));
    expect(wallet.toProps().balance.amount).toBe(100);
  });
});
```

`services/wallet/src/domain/ledger-transaction.test.ts`:
```ts
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { InvalidLedgerTransactionError } from './errors.js';
import { LedgerTransaction } from './ledger-transaction.js';

const now = new Date('2026-10-10T10:00:00.000Z');
const entry = (accountId: string, amount: number, currency: 'VND' | 'USD' = 'VND') => ({
  accountId,
  amount: Money.of(amount, currency),
});
const make = (entries = [entry('a', 100), entry('b', -100)], businessKey = 'k1') =>
  LedgerTransaction.create({ id: 'tx_1', businessKey, kind: 'TOPUP', entries, now });

describe('LedgerTransaction.create', () => {
  it('accepts a balanced transaction', () => {
    expect(make().toProps()).toMatchObject({ id: 'tx_1', businessKey: 'k1', kind: 'TOPUP', createdAt: now });
    expect(make().toProps().entries).toHaveLength(2);
  });

  it('accepts three balanced entries', () => {
    expect(() => make([entry('a', 70), entry('b', 30), entry('c', -100)])).not.toThrow();
  });

  it.each([
    ['unbalanced entries', [entry('a', 100), entry('b', -99)]],
    ['a single entry', [entry('a', 0)]],
    ['no entries', []],
    ['a zero entry', [entry('a', 100), entry('b', 0), entry('c', -100)]],
    ['duplicate accounts', [entry('a', 100), entry('a', -100)]],
    ['mixed currencies', [entry('a', 100), entry('b', -100, 'USD')]],
  ])('rejects %s', (_name, entries) => {
    expect(() => make(entries)).toThrow(InvalidLedgerTransactionError);
  });

  it.each(['', 'k'.repeat(201)])('rejects business key %j', (businessKey) => {
    expect(() => make(undefined, businessKey)).toThrow(InvalidLedgerTransactionError);
  });

  it('accepts a business key of exactly 200 characters', () => {
    expect(() => make(undefined, 'k'.repeat(200))).not.toThrow();
  });

  it('does not let callers mutate the stored entries', () => {
    const entries = [entry('a', 100), entry('b', -100)];
    const tx = make(entries);
    entries.push(entry('c', 5));
    expect(tx.toProps().entries).toHaveLength(2);
  });
});

describe('LedgerTransaction.topup', () => {
  const topup = (amount: number) =>
    LedgerTransaction.topup({
      id: 'tx_1',
      topupId: 'tp_1',
      walletAccountId: 'wallet:c1',
      gatewayAccountId: 'system:GATEWAY:VND',
      amount: Money.of(amount, 'VND'),
      now,
    });

  it('credits the wallet and debits the gateway under the topup business key', () => {
    const props = topup(1500).toProps();
    expect(props.businessKey).toBe('topup:tp_1');
    expect(props.kind).toBe('TOPUP');
    expect(props.entries.map((e) => [e.accountId, e.amount.amount])).toEqual([
      ['wallet:c1', 1500],
      ['system:GATEWAY:VND', -1500],
    ]);
  });

  it.each([0, -5])('rejects a non-positive amount (%d)', (amount) => {
    expect(() => topup(amount)).toThrow(InvalidLedgerTransactionError);
  });
});
```

`services/wallet/src/domain/topup.test.ts`:
```ts
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { CustomerId } from './customer-id.js';
import { InvalidTopupError, StateTransitionError } from './errors.js';
import { Topup } from './topup.js';

const t0 = new Date('2026-10-10T10:00:00.000Z');
const plus = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

const requested = () =>
  Topup.request({
    id: 'tp_1',
    customerId: CustomerId.parse('c1'),
    accountId: 'wallet:c1',
    amount: Money.of(1500, 'VND'),
    now: t0,
  });

describe('Topup.request', () => {
  it('starts REQUESTED and due immediately', () => {
    expect(requested().toProps()).toMatchObject({
      id: 'tp_1',
      customerId: 'c1',
      accountId: 'wallet:c1',
      status: 'REQUESTED',
      chargeId: null,
      failureCode: null,
      attempts: 0,
      nextAttemptAt: t0,
      createdAt: t0,
      completedAt: null,
    });
    expect(requested().isDue(t0)).toBe(true);
    expect(requested().isDue(new Date(t0.getTime() - 1))).toBe(false);
  });

  it.each([0, -1])('rejects a non-positive amount (%d)', (amount) => {
    expect(() =>
      Topup.request({
        id: 'tp_x',
        customerId: CustomerId.parse('c1'),
        accountId: 'wallet:c1',
        amount: Money.of(amount, 'VND'),
        now: t0,
      }),
    ).toThrow(InvalidTopupError);
  });
});

describe('Topup submission lifecycle', () => {
  it('claim() pushes the next attempt out by the lease without counting an attempt', () => {
    const claimed = requested().claim(t0, 60);
    expect(claimed.toProps()).toMatchObject({ status: 'REQUESTED', attempts: 0 });
    expect(claimed.toProps().nextAttemptAt).toEqual(plus(60));
    expect(claimed.isDue(plus(59))).toBe(false);
    expect(claimed.isDue(plus(60))).toBe(true);
  });

  it('recordSubmitted() moves to PENDING with the charge id', () => {
    const pending = requested().recordSubmitted('ch_1');
    expect(pending.toProps()).toMatchObject({
      status: 'PENDING',
      chargeId: 'ch_1',
      attempts: 1,
      nextAttemptAt: null,
      completedAt: null,
    });
    expect(pending.isDue(plus(1000))).toBe(false);
  });

  it('recordRejected() fails immediately with PAYMENT_REJECTED', () => {
    expect(requested().recordRejected(plus(1)).toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'PAYMENT_REJECTED',
      attempts: 1,
      nextAttemptAt: null,
      completedAt: plus(1),
    });
  });

  it('recordUnavailable() follows the backoff and then gives up with PAYMENT_UNAVAILABLE', () => {
    const backoff = [1, 5];
    const first = requested().recordUnavailable(plus(10), backoff);
    expect(first.toProps()).toMatchObject({ status: 'REQUESTED', attempts: 1 });
    expect(first.toProps().nextAttemptAt).toEqual(plus(11));

    const second = first.recordUnavailable(plus(20), backoff);
    expect(second.toProps()).toMatchObject({ status: 'REQUESTED', attempts: 2 });
    expect(second.toProps().nextAttemptAt).toEqual(plus(25));

    const third = second.recordUnavailable(plus(30), backoff);
    expect(third.toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'PAYMENT_UNAVAILABLE',
      attempts: 3,
      nextAttemptAt: null,
      completedAt: plus(30),
    });
  });

  it('gives up at once when the backoff list is empty', () => {
    expect(requested().recordUnavailable(t0, []).toProps().status).toBe('FAILED');
  });

  it.each(['claim', 'recordSubmitted', 'recordRejected', 'recordUnavailable'] as const)(
    '%s() is rejected unless the topup is REQUESTED',
    (method) => {
      const pending = requested().recordSubmitted('ch_1');
      const call = () => {
        if (method === 'claim') pending.claim(t0, 60);
        else if (method === 'recordSubmitted') pending.recordSubmitted('ch_2');
        else if (method === 'recordRejected') pending.recordRejected(t0);
        else pending.recordUnavailable(t0, [1]);
      };
      expect(call).toThrow(StateTransitionError);
    },
  );
});

describe('Topup result application', () => {
  it('applySucceeded() completes a REQUESTED, a PENDING or a late FAILED(PAYMENT_UNAVAILABLE) topup', () => {
    const done = (topup: Topup) => topup.applySucceeded('ch_9', plus(5)).toProps();
    for (const topup of [
      requested(),
      requested().recordSubmitted('ch_1'),
      requested().recordUnavailable(t0, []),
    ]) {
      expect(done(topup)).toMatchObject({
        status: 'SUCCEEDED',
        chargeId: 'ch_9',
        nextAttemptAt: null,
        completedAt: plus(5),
      });
    }
  });

  it('applySucceeded() refuses a FAILED topup that failed for another reason, and a SUCCEEDED one', () => {
    expect(() => requested().recordRejected(t0).applySucceeded('ch_1', t0)).toThrow(StateTransitionError);
    const failed = requested().applyFailed('card_declined', 'ch_1', t0);
    expect(() => failed.applySucceeded('ch_1', t0)).toThrow(StateTransitionError);
    const succeeded = requested().applySucceeded('ch_1', t0);
    expect(() => succeeded.applySucceeded('ch_1', t0)).toThrow(StateTransitionError);
  });

  it('applyFailed() fails a REQUESTED or PENDING topup with the gateway failure code', () => {
    for (const topup of [requested(), requested().recordSubmitted('ch_1')]) {
      expect(topup.applyFailed('card_declined', 'ch_1', plus(5)).toProps()).toMatchObject({
        status: 'FAILED',
        failureCode: 'card_declined',
        chargeId: 'ch_1',
        nextAttemptAt: null,
        completedAt: plus(5),
      });
    }
  });

  it('applyFailed() never overrides a SUCCEEDED or FAILED topup', () => {
    expect(() => requested().applySucceeded('ch_1', t0).applyFailed('x_y', 'ch_1', t0)).toThrow(
      StateTransitionError,
    );
    expect(() => requested().recordRejected(t0).applyFailed('x_y', 'ch_1', t0)).toThrow(StateTransitionError);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet/src/domain`
Expected: FAIL (không resolve được `./account.js`, `./ledger-transaction.js`, `./topup.js`).

- [ ] **Step 3: Cài code**

`services/wallet/src/domain/account.ts`:
```ts
import { Money, type Currency } from '@billing/money';
import type { CustomerId } from './customer-id.js';
import { InsufficientFundsError, LedgerInvariantError } from './errors.js';

export type AccountKind = 'WALLET' | 'GATEWAY' | 'MERCHANT';

export interface AccountProps {
  readonly id: string;
  readonly kind: AccountKind;
  readonly customerId: string | null;
  readonly currency: Currency;
  readonly balance: Money;
  readonly createdAt: Date;
}

export class Account {
  private constructor(private readonly props: AccountProps) {}

  static walletId(customerId: CustomerId): string {
    return `wallet:${customerId.value}`;
  }

  static systemId(kind: 'GATEWAY' | 'MERCHANT', currency: Currency): string {
    return `system:${kind}:${currency}`;
  }

  static openWallet(input: { customerId: CustomerId; currency: Currency; now: Date }): Account {
    return new Account({
      id: Account.walletId(input.customerId),
      kind: 'WALLET',
      customerId: input.customerId.value,
      currency: input.currency,
      balance: Money.zero(input.currency),
      createdAt: input.now,
    });
  }

  static rehydrate(props: AccountProps): Account {
    return new Account(props);
  }

  /** Áp một khoản thay đổi có dấu; từ chối nếu làm số dư vi phạm quy tắc của loại tài khoản. */
  apply(delta: Money): Account {
    if (delta.currency !== this.props.currency) {
      throw new LedgerInvariantError(
        `cannot apply ${delta.currency} to ${this.props.currency} account ${this.props.id}`,
      );
    }
    const next = this.props.balance.add(delta);
    switch (this.props.kind) {
      case 'WALLET':
        if (next.isNegative()) {
          throw new InsufficientFundsError(`wallet ${this.props.id} would go negative`);
        }
        break;
      case 'GATEWAY':
        if (next.isPositive()) {
          throw new LedgerInvariantError(`gateway account ${this.props.id} cannot be positive`);
        }
        break;
      case 'MERCHANT':
        if (next.isNegative()) {
          throw new LedgerInvariantError(`merchant account ${this.props.id} cannot be negative`);
        }
        break;
    }
    return new Account({ ...this.props, balance: next });
  }

  toProps(): AccountProps {
    return { ...this.props };
  }
}
```

`services/wallet/src/domain/ledger-transaction.ts`:
```ts
import { Money } from '@billing/money';
import { InvalidLedgerTransactionError } from './errors.js';

export interface LedgerEntry {
  readonly accountId: string;
  readonly amount: Money;
}

export type LedgerTransactionKind = 'TOPUP';

export interface LedgerTransactionProps {
  readonly id: string;
  readonly businessKey: string;
  readonly kind: LedgerTransactionKind;
  readonly entries: readonly LedgerEntry[];
  readonly createdAt: Date;
}

const MAX_BUSINESS_KEY_LENGTH = 200;

export class LedgerTransaction {
  private constructor(private readonly props: LedgerTransactionProps) {}

  static create(input: {
    id: string;
    businessKey: string;
    kind: LedgerTransactionKind;
    entries: readonly LedgerEntry[];
    now: Date;
  }): LedgerTransaction {
    if (input.businessKey.length === 0 || input.businessKey.length > MAX_BUSINESS_KEY_LENGTH) {
      throw new InvalidLedgerTransactionError(
        `business key must be 1..${MAX_BUSINESS_KEY_LENGTH} characters`,
      );
    }
    const [first] = input.entries;
    if (input.entries.length < 2 || first === undefined) {
      throw new InvalidLedgerTransactionError('a transaction needs at least two entries');
    }
    const currency = first.amount.currency;
    const accounts = new Set<string>();
    let sum = Money.zero(currency);
    for (const entry of input.entries) {
      if (entry.amount.currency !== currency) {
        throw new InvalidLedgerTransactionError('all entries must use the same currency');
      }
      if (entry.amount.isZero()) {
        throw new InvalidLedgerTransactionError('entries must not be zero');
      }
      if (accounts.has(entry.accountId)) {
        throw new InvalidLedgerTransactionError(`account ${entry.accountId} appears more than once`);
      }
      accounts.add(entry.accountId);
      sum = sum.add(entry.amount);
    }
    if (!sum.isZero()) {
      throw new InvalidLedgerTransactionError('entries must sum to zero');
    }
    return new LedgerTransaction({
      id: input.id,
      businessKey: input.businessKey,
      kind: input.kind,
      entries: [...input.entries],
      createdAt: input.now,
    });
  }

  /** Nạp tiền: ví `+amount`, GATEWAY `−amount`, khóa nghiệp vụ `topup:<topupId>`. */
  static topup(input: {
    id: string;
    topupId: string;
    walletAccountId: string;
    gatewayAccountId: string;
    amount: Money;
    now: Date;
  }): LedgerTransaction {
    if (!input.amount.isPositive()) {
      throw new InvalidLedgerTransactionError('a top-up amount must be positive');
    }
    return LedgerTransaction.create({
      id: input.id,
      businessKey: `topup:${input.topupId}`,
      kind: 'TOPUP',
      entries: [
        { accountId: input.walletAccountId, amount: input.amount },
        { accountId: input.gatewayAccountId, amount: input.amount.negate() },
      ],
      now: input.now,
    });
  }

  toProps(): LedgerTransactionProps {
    return { ...this.props, entries: [...this.props.entries] };
  }
}
```

`services/wallet/src/domain/topup.ts`:
```ts
import type { Money } from '@billing/money';
import type { CustomerId } from './customer-id.js';
import { InvalidTopupError, StateTransitionError } from './errors.js';

export type TopupStatus = 'REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface TopupProps {
  readonly id: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly status: TopupStatus;
  readonly chargeId: string | null;
  readonly failureCode: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

const PAYMENT_REJECTED = 'PAYMENT_REJECTED';
const PAYMENT_UNAVAILABLE = 'PAYMENT_UNAVAILABLE';

const addSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

export class Topup {
  private constructor(private readonly props: TopupProps) {}

  static request(input: {
    id: string;
    customerId: CustomerId;
    accountId: string;
    amount: Money;
    now: Date;
  }): Topup {
    if (!input.amount.isPositive()) {
      throw new InvalidTopupError('amount must be at least 1 minor unit');
    }
    return new Topup({
      id: input.id,
      customerId: input.customerId.value,
      accountId: input.accountId,
      amount: input.amount,
      status: 'REQUESTED',
      chargeId: null,
      failureCode: null,
      attempts: 0,
      nextAttemptAt: input.now,
      createdAt: input.now,
      completedAt: null,
    });
  }

  static rehydrate(props: TopupProps): Topup {
    return new Topup(props);
  }

  isDue(now: Date): boolean {
    return (
      this.props.status === 'REQUESTED' &&
      this.props.nextAttemptAt !== null &&
      this.props.nextAttemptAt.getTime() <= now.getTime()
    );
  }

  /** Chiếm lần nạp để gửi sang payment: đẩy lịch lên sau `leaseSeconds`, chưa tính là một lần thử. */
  claim(now: Date, leaseSeconds: number): Topup {
    this.assertRequested('claim');
    return new Topup({ ...this.props, nextAttemptAt: addSeconds(now, leaseSeconds) });
  }

  recordSubmitted(chargeId: string): Topup {
    this.assertRequested('recordSubmitted');
    return new Topup({
      ...this.props,
      status: 'PENDING',
      chargeId,
      attempts: this.props.attempts + 1,
      nextAttemptAt: null,
    });
  }

  recordRejected(now: Date): Topup {
    this.assertRequested('recordRejected');
    return new Topup({
      ...this.props,
      status: 'FAILED',
      failureCode: PAYMENT_REJECTED,
      attempts: this.props.attempts + 1,
      nextAttemptAt: null,
      completedAt: now,
    });
  }

  /** Lần thất bại thứ n (n <= len) hẹn lại sau `backoff[n-1]` giây; thứ len+1 thì FAILED. */
  recordUnavailable(now: Date, backoffSeconds: readonly number[]): Topup {
    this.assertRequested('recordUnavailable');
    const attempts = this.props.attempts + 1;
    const delay = backoffSeconds[attempts - 1];
    if (delay === undefined) {
      return new Topup({
        ...this.props,
        status: 'FAILED',
        failureCode: PAYMENT_UNAVAILABLE,
        attempts,
        nextAttemptAt: null,
        completedAt: now,
      });
    }
    return new Topup({ ...this.props, attempts, nextAttemptAt: addSeconds(now, delay) });
  }

  /** Thành công từ webhook; cho phép cả khi lần nạp đã FAILED vì PAYMENT_UNAVAILABLE (cổng thanh toán là nguồn sự thật). */
  applySucceeded(chargeId: string, now: Date): Topup {
    const { status, failureCode } = this.props;
    const lateSuccess = status === 'FAILED' && failureCode === PAYMENT_UNAVAILABLE;
    if (status !== 'REQUESTED' && status !== 'PENDING' && !lateSuccess) {
      throw new StateTransitionError(`topup ${this.props.id} cannot succeed from ${status}`);
    }
    return new Topup({
      ...this.props,
      status: 'SUCCEEDED',
      chargeId,
      failureCode: null,
      nextAttemptAt: null,
      completedAt: now,
    });
  }

  applyFailed(failureCode: string, chargeId: string, now: Date): Topup {
    const { status } = this.props;
    if (status !== 'REQUESTED' && status !== 'PENDING') {
      throw new StateTransitionError(`topup ${this.props.id} cannot fail from ${status}`);
    }
    return new Topup({
      ...this.props,
      status: 'FAILED',
      chargeId,
      failureCode,
      nextAttemptAt: null,
      completedAt: now,
    });
  }

  toProps(): TopupProps {
    return { ...this.props };
  }

  private assertRequested(operation: string): void {
    if (this.props.status !== 'REQUESTED') {
      throw new StateTransitionError(
        `topup ${this.props.id} is ${this.props.status}, cannot ${operation}`,
      );
    }
  }
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run services/wallet/src/domain && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS; lint xác nhận `domain/` chỉ import `@billing/money` và file cùng lớp.

- [ ] **Step 5: Commit**

```bash
git add services/wallet/src/domain
git commit -m "feat(wallet): add Account, LedgerTransaction and Topup domain"
```

### Task 5: Migration theo tenant, provisioning và `db:migrate:wallet`

**Files:**
- Modify: `packages/database/src/errors.ts`, `packages/database/src/config.ts`, `packages/database/src/config.test.ts`, `packages/database/src/migrate.ts` (viết lại), `packages/database/src/index.ts`, `package.json` (gốc)
- Create: `services/wallet/src/infrastructure/kysely/schema-name.ts`, `kysely/migrations/001-ledger.ts`, `kysely/migrations/002-topups.ts`, `kysely/migrations/index.ts`, `kysely/provisioning.ts`, `db/wallet/migrate.ts`
- Test: `packages/database/src/errors.test.ts` (thêm ca), `packages/testing/src/database-schema.integration.test.ts`, `services/wallet/src/infrastructure/kysely/provisioning.integration.test.ts`

**Interfaces:**
- Produces (`@billing/database`):
  - `isMissingObject(error: unknown): boolean` (số lỗi SQL Server `208`: bảng hoặc schema không tồn tại)
  - `interface MigrateOptions { migrationTableSchema?: string }`; `migrate<DB>(db, migrations, options?: MigrateOptions): Promise<string[]>` (thêm tham số tùy chọn; hành vi cũ giữ nguyên khi không truyền)
  - `pendingMigrations<DB>(db, migrations, options?: MigrateOptions): Promise<string[]>` — tên các migration chưa chạy (đã sắp xếp), đọc trực tiếp bảng `kysely_migration` (không tạo bảng, không cần quyền DDL); bảng/schema chưa có → tất cả đều chưa chạy
  - `migratorConfigFromEnv(prefix: string, migratorPrefix: string, env: NodeJS.ProcessEnv): DatabaseConfig` — như `databaseConfigFromEnv(prefix, env)` nhưng nếu `<migratorPrefix>_USER` và `<migratorPrefix>_PASSWORD` có giá trị thì dùng chúng thay cho `user`/`password` của ứng dụng (host, cổng, tên DB giữ nguyên). Giá trị rỗng/chỉ có khoảng trắng coi như chưa đặt (vì `.env.example` để trống); chỉ đặt một trong hai → `ConfigError` `"<migratorPrefix>_USER and <migratorPrefix>_PASSWORD must be set together"`
- Produces (wallet):
  - `schemaName(tenant: TenantId): string` = `t_<tenant>`
  - `walletMigrations(schema: string): Record<string, Migration>` với khóa `'001-ledger'`, `'002-topups'`; ném lỗi nếu `schema` không khớp `^t_[a-z][a-z0-9-]{0,39}$`
  - `provisionTenants(owner: Kysely<unknown>, tenants: readonly TenantId[]): Promise<Record<string, string[]>>` — mỗi tenant: tạo schema nếu chưa có rồi chạy migration trong schema đó (bảng theo dõi nằm trong schema); trả về các migration vừa áp dụng theo tenant; idempotent
  - `assertMigrated(db: Kysely<unknown>, tenants: readonly TenantId[]): Promise<void>` — ném lỗi liệt kê tenant và migration còn thiếu
  - lệnh `corepack pnpm db:migrate:wallet`: đọc `WALLET_DB_*` và `WALLET_TENANTS`; nếu có `WALLET_MIGRATOR_DB_USER` + `WALLET_MIGRATOR_DB_PASSWORD` (phải đặt cùng nhau) thì dùng chúng thay cho user/password ứng dụng (xem mục 2 của "Những điều đã kiểm chứng": `Migrator` cần `db_owner`)
- Schema mỗi tenant (chi tiết ở spec mục 4): `accounts`, `ledger_transactions`, `ledger_entries`, `topups`, `idempotency_keys`, `processed_messages`; 4 tài khoản hệ thống `system:GATEWAY:VND|USD`, `system:MERCHANT:VND|USD` với số dư 0; trigger `instead of update, delete` trên `ledger_entries` và `ledger_transactions` ném lỗi `50001` (`ledger is immutable`).

- [ ] **Step 1: Viết test thất bại cho phần `@billing/database`**

Thêm vào `packages/database/src/errors.test.ts` (giữ nguyên các test cũ; thêm import `isMissingObject` cùng dòng import hiện có) khối sau ở cuối file:
```ts
describe('isMissingObject', () => {
  it('recognises SQL Server error 208 (invalid object name)', () => {
    expect(isMissingObject({ number: 208 })).toBe(true);
  });

  it.each([null, undefined, 'x', new Error('boom'), { number: 2627 }, { number: '208' }])(
    'rejects %j',
    (value) => {
      expect(isMissingObject(value)).toBe(false);
    },
  );
});
```

Thêm vào `packages/database/src/config.test.ts` (đổi dòng import thành `import { ConfigError, databaseConfigFromEnv, migratorConfigFromEnv } from './config.js';`) khối sau ở cuối file:
```ts
describe('migratorConfigFromEnv', () => {
  const app = {
    WALLET_DB_HOST: 'db',
    WALLET_DB_PORT: '14333',
    WALLET_DB_NAME: 'billing_wallet',
    WALLET_DB_USER: 'app',
    WALLET_DB_PASSWORD: 'app-secret',
  };
  const migrator = (env: NodeJS.ProcessEnv) => migratorConfigFromEnv('WALLET_DB', 'WALLET_MIGRATOR_DB', env);

  it('uses the application account when no migrator account is set', () => {
    expect(migrator(app)).toEqual({
      host: 'db',
      port: 14333,
      database: 'billing_wallet',
      user: 'app',
      password: 'app-secret',
    });
  });

  it('swaps in the migrator account and keeps host, port and database', () => {
    expect(
      migrator({ ...app, WALLET_MIGRATOR_DB_USER: 'owner', WALLET_MIGRATOR_DB_PASSWORD: 'owner-secret' }),
    ).toEqual({ host: 'db', port: 14333, database: 'billing_wallet', user: 'owner', password: 'owner-secret' });
  });

  it('treats blank migrator values (an untouched .env.example) as not set', () => {
    expect(migrator({ ...app, WALLET_MIGRATOR_DB_USER: '', WALLET_MIGRATOR_DB_PASSWORD: '  ' }).user).toBe('app');
  });

  it.each([
    [{ WALLET_MIGRATOR_DB_USER: 'owner' }],
    [{ WALLET_MIGRATOR_DB_PASSWORD: 'owner-secret' }],
    [{ WALLET_MIGRATOR_DB_USER: 'owner', WALLET_MIGRATOR_DB_PASSWORD: '' }],
  ])('refuses a half-set migrator account %j', (extra) => {
    try {
      migrator({ ...app, ...extra });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        'WALLET_MIGRATOR_DB_USER and WALLET_MIGRATOR_DB_PASSWORD must be set together',
      ]);
    }
  });

  it('still reports missing application variables', () => {
    expect(() => migrator({})).toThrow(ConfigError);
  });
});
```

`packages/testing/src/database-schema.integration.test.ts`:
```ts
import { createDatabase, migrate, pendingMigrations, type Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './sql-server.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;

const migrations: Record<string, Migration> = {
  '001-a': {
    up: async (database: Kysely<unknown>) => {
      await sql`create table [s_one].[a] (id int primary key)`.execute(database);
    },
  },
  '002-b': {
    up: async (database: Kysely<unknown>) => {
      await sql`create table [s_one].[b] (id int primary key)`.execute(database);
    },
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase('dbschema');
  db = createDatabase<unknown>(testDb.config);
  await sql`create schema [s_one]`.execute(db);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

describe('migrate / pendingMigrations with migrationTableSchema', () => {
  it('reports everything pending before the schema has a migration table, without creating one', async () => {
    expect(await pendingMigrations(db, migrations, { migrationTableSchema: 's_one' })).toEqual(['001-a', '002-b']);
    const tables = await sql<{ name: string }>`select name from sys.tables`.execute(db);
    expect(tables.rows.map((r) => r.name)).not.toContain('kysely_migration');
  });

  it('also treats a schema that does not exist as fully pending', async () => {
    expect(await pendingMigrations(db, migrations, { migrationTableSchema: 's_missing' })).toEqual([
      '001-a',
      '002-b',
    ]);
  });

  it('keeps the migration bookkeeping in the given schema and is idempotent', async () => {
    expect(await migrate(db, migrations, { migrationTableSchema: 's_one' })).toEqual(['001-a', '002-b']);
    expect(await migrate(db, migrations, { migrationTableSchema: 's_one' })).toEqual([]);
    const tables = await sql<{ schema_name: string; name: string }>`
      select s.name as schema_name, t.name from sys.tables t join sys.schemas s on s.schema_id = t.schema_id
      where t.name in ('kysely_migration', 'kysely_migration_lock')`.execute(db);
    expect(tables.rows.map((r) => `${r.schema_name}.${r.name}`).sort()).toEqual([
      's_one.kysely_migration',
      's_one.kysely_migration_lock',
    ]);
    expect(await pendingMigrations(db, migrations, { migrationTableSchema: 's_one' })).toEqual([]);
  });

  it('lists only the migrations that were not applied yet', async () => {
    const more: Record<string, Migration> = {
      ...migrations,
      '003-c': { up: async () => undefined },
    };
    expect(await pendingMigrations(db, more, { migrationTableSchema: 's_one' })).toEqual(['003-c']);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/database/src/errors.test.ts && corepack pnpm test:integration database-schema`
Expected: FAIL (`isMissingObject`, `pendingMigrations` và tham số `options` chưa tồn tại).

- [ ] **Step 3: Cài phần `@billing/database`**

Thêm vào **cuối** `packages/database/src/config.ts`:
```ts

const isSet = (value: string | undefined): value is string => value !== undefined && value.trim() !== '';

/**
 * Cấu hình cho lệnh migrate. `Migrator` của Kysely cần tài khoản thuộc `db_owner`, còn tài khoản ứng dụng
 * chỉ có DML; nên cho phép thay `user`/`password` bằng tài khoản migrator (đặt cả hai hoặc không đặt gì).
 */
export function migratorConfigFromEnv(
  prefix: string,
  migratorPrefix: string,
  env: NodeJS.ProcessEnv,
): DatabaseConfig {
  const base = databaseConfigFromEnv(prefix, env);
  const user = env[`${migratorPrefix}_USER`];
  const password = env[`${migratorPrefix}_PASSWORD`];
  if (!isSet(user) && !isSet(password)) return base;
  if (!isSet(user) || !isSet(password)) {
    throw new ConfigError([`${migratorPrefix}_USER and ${migratorPrefix}_PASSWORD must be set together`]);
  }
  return { ...base, user, password };
}
```
Trong `packages/database/src/index.ts`: đổi dòng đầu thành `export { ConfigError, databaseConfigFromEnv, migratorConfigFromEnv } from './config.js';`.

Thêm vào `packages/database/src/errors.ts` (giữ `isUniqueViolation`):
```ts
/** 208: Invalid object name (bảng hoặc schema không tồn tại). */
export function isMissingObject(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { number?: unknown }).number === 208;
}
```

Viết lại toàn bộ `packages/database/src/migrate.ts`:
```ts
import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';
import { isMissingObject } from './errors.js';

export type { Migration };

export interface MigrateOptions {
  /** Đặt bảng theo dõi migration của Kysely trong schema này (schema phải tồn tại trước). */
  migrationTableSchema?: string;
}

const MIGRATION_TABLE = 'kysely_migration';

/**
 * Áp dụng mọi migration chưa chạy theo thứ tự tên; ném lỗi nếu có migration thất bại.
 * Lưu ý: `Migrator` của Kysely dùng `sp_getapplock` nên phải chạy bằng tài khoản thuộc `db_owner`.
 */
export async function migrate<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
  options: MigrateOptions = {},
): Promise<string[]> {
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: { getMigrations: async () => migrations },
    ...(options.migrationTableSchema === undefined
      ? {}
      : { migrationTableSchema: options.migrationTableSchema }),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

/**
 * Tên các migration chưa chạy, đọc thẳng bảng theo dõi (không tạo bảng, không cần quyền DDL).
 * Bảng hoặc schema chưa tồn tại nghĩa là chưa migration nào chạy.
 */
export async function pendingMigrations<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
  options: MigrateOptions = {},
): Promise<string[]> {
  const table =
    options.migrationTableSchema === undefined
      ? sql.id(MIGRATION_TABLE)
      : sql.id(options.migrationTableSchema, MIGRATION_TABLE);
  let executed: Set<string>;
  try {
    const result = await sql<{ name: string }>`select name from ${table}`.execute(db);
    executed = new Set(result.rows.map((row) => row.name));
  } catch (error) {
    if (!isMissingObject(error)) throw error;
    executed = new Set();
  }
  return Object.keys(migrations)
    .filter((name) => !executed.has(name))
    .sort();
}
```

Trong `packages/database/src/index.ts`: đổi dòng `export { isUniqueViolation } from './errors.js';` thành `export { isMissingObject, isUniqueViolation } from './errors.js';` và đổi dòng export `migrate` thành:
```ts
export { migrate, pendingMigrations } from './migrate.js';
export type { MigrateOptions, Migration } from './migrate.js';
```
(xóa dòng `export type { Migration } from './migrate.js';` cũ để không trùng).

- [ ] **Step 4: Chạy lại test**

Run: `corepack pnpm exec vitest run packages/database && corepack pnpm test:integration database-schema database.integration`
Expected: PASS (các test cũ của `database.integration.test.ts` vẫn đạt vì tham số mới là tùy chọn).

- [ ] **Step 5: Viết test thất bại cho migration của wallet**

`services/wallet/src/infrastructure/kysely/provisioning.integration.test.ts`:
```ts
import { createDatabase, dateTime } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { assertMigrated, provisionTenants } from './provisioning.js';
import { schemaName } from './schema-name.js';

const acme = TenantId.parse('acme');
const beta = TenantId.parse('beta');

let testDb: TestDatabase;
let db: Kysely<unknown>;

beforeAll(async () => {
  testDb = await createTestDatabase('provision');
  db = createDatabase<unknown>(testDb.config);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const t = (tenant: TenantId, table: string) => sql.id(schemaName(tenant), table);
const now = () => dateTime(new Date('2026-10-10T10:00:00.000Z'));

describe('provisionTenants', () => {
  it('refuses to start against tenants that were never provisioned', async () => {
    await expect(assertMigrated(db, [acme])).rejects.toThrow(/acme/);
  });

  it('creates both tenant schemas, applies every migration, and is idempotent', async () => {
    expect(await provisionTenants(db, [acme, beta])).toEqual({
      acme: ['001-ledger', '002-topups'],
      beta: ['001-ledger', '002-topups'],
    });
    expect(await provisionTenants(db, [acme, beta])).toEqual({ acme: [], beta: [] });
    await expect(assertMigrated(db, [acme, beta])).resolves.toBeUndefined();
  });

  it('names the tenant and the missing migrations when one is behind', async () => {
    await provisionTenants(db, [TenantId.parse('gamma')]);
    await sql`delete from ${sql.id('t_gamma', 'kysely_migration')} where name = '002-topups'`.execute(db);
    await expect(assertMigrated(db, [TenantId.parse('gamma')])).rejects.toThrow(/gamma.*002-topups/);
  });

  it('puts the same tables in each tenant schema, with the four system accounts', async () => {
    for (const tenant of [acme, beta]) {
      const tables = await sql<{ name: string }>`
        select t.name from sys.tables t join sys.schemas s on s.schema_id = t.schema_id
        where s.name = ${schemaName(tenant)}`.execute(db);
      expect(tables.rows.map((r) => r.name).sort()).toEqual([
        'accounts',
        'idempotency_keys',
        'kysely_migration',
        'kysely_migration_lock',
        'ledger_entries',
        'ledger_transactions',
        'processed_messages',
        'topups',
      ]);
      const accounts = await sql<{ id: string; kind: string; balance: string }>`
        select id, kind, balance from ${t(tenant, 'accounts')} order by id`.execute(db);
      expect(accounts.rows).toEqual([
        { id: 'system:GATEWAY:USD', kind: 'GATEWAY', balance: '0' },
        { id: 'system:GATEWAY:VND', kind: 'GATEWAY', balance: '0' },
        { id: 'system:MERCHANT:USD', kind: 'MERCHANT', balance: '0' },
        { id: 'system:MERCHANT:VND', kind: 'MERCHANT', balance: '0' },
      ]);
    }
  });

  it('keeps tenants isolated even with identical ids', async () => {
    for (const [tenant, balance] of [[acme, 100], [beta, 5]] as const) {
      await sql`insert into ${t(tenant, 'accounts')} (id, kind, customer_id, currency, balance, created_at)
        values (${'wallet:c1'}, 'WALLET', ${'c1'}, 'VND', ${balance}, ${now()})`.execute(db);
    }
    const read = async (tenant: TenantId) =>
      (await sql<{ balance: string }>`select balance from ${t(tenant, 'accounts')} where id = ${'wallet:c1'}`.execute(db)).rows;
    expect(await read(acme)).toEqual([{ balance: '100' }]);
    expect(await read(beta)).toEqual([{ balance: '5' }]);
  });
});

describe('ledger and account constraints (tenant acme)', () => {
  const insertAccount = (id: string, kind: string, balance: number, currency = 'VND') =>
    sql`insert into ${t(acme, 'accounts')} (id, kind, customer_id, currency, balance, created_at)
      values (${id}, ${kind}, null, ${currency}, ${balance}, ${now()})`.execute(db);
  const insertTransaction = (id: string, businessKey: string) =>
    sql`insert into ${t(acme, 'ledger_transactions')} (id, business_key, kind, created_at)
      values (${id}, ${businessKey}, 'TOPUP', ${now()})`.execute(db);
  const insertEntry = (transactionId: string, accountId: string, amount: number) =>
    sql`insert into ${t(acme, 'ledger_entries')} (transaction_id, account_id, amount, created_at)
      values (${transactionId}, ${accountId}, ${amount}, ${now()})`.execute(db);

  it.each([
    ['a negative wallet', 'WALLET', -1],
    ['a positive gateway account', 'GATEWAY', 1],
    ['a negative merchant account', 'MERCHANT', -1],
  ])('rejects %s with a CHECK violation', async (_name, kind, balance) => {
    await expect(insertAccount(`bad-${kind}`, kind, balance)).rejects.toMatchObject({ number: 547 });
  });

  it('rejects an unknown kind and an unsupported currency', async () => {
    await expect(insertAccount('bad-kind', 'OTHER', 0)).rejects.toMatchObject({ number: 547 });
    await expect(insertAccount('bad-cur', 'WALLET', 0, 'EUR')).rejects.toMatchObject({ number: 547 });
  });

  it('enforces a unique business key (duplicate ledger postings are impossible)', async () => {
    await insertTransaction('tx_a', 'topup:one');
    await expect(insertTransaction('tx_b', 'topup:one')).rejects.toMatchObject({ number: 2627 });
  });

  it('rejects a zero entry, but accepts positive and negative ones', async () => {
    await insertTransaction('tx_c', 'topup:two');
    await expect(insertEntry('tx_c', 'system:GATEWAY:VND', 0)).rejects.toMatchObject({ number: 547 });
    await insertEntry('tx_c', 'system:GATEWAY:VND', -50);
    await insertEntry('tx_c', 'system:MERCHANT:VND', 50);
  });

  it('makes the ledger append-only: UPDATE and DELETE fail with 50001 on both ledger tables', async () => {
    await insertTransaction('tx_d', 'topup:three');
    await insertEntry('tx_d', 'system:GATEWAY:VND', -1);
    await expect(
      sql`update ${t(acme, 'ledger_entries')} set amount = 9`.execute(db),
    ).rejects.toMatchObject({ number: 50001 });
    await expect(sql`delete from ${t(acme, 'ledger_entries')}`.execute(db)).rejects.toMatchObject({ number: 50001 });
    await expect(
      sql`update ${t(acme, 'ledger_transactions')} set kind = 'TOPUP'`.execute(db),
    ).rejects.toMatchObject({ number: 50001 });
    await expect(sql`delete from ${t(acme, 'ledger_transactions')}`.execute(db)).rejects.toMatchObject({
      number: 50001,
    });
  });

  it('accepts only known topup statuses and positive amounts', async () => {
    await insertAccount('wallet:c9', 'WALLET', 0);
    const topup = (status: string, amount: number) =>
      sql`insert into ${t(acme, 'topups')}
        (id, customer_id, account_id, amount, currency, status, attempts, next_attempt_at, created_at)
        values (${`tp_${status}_${amount}`}, 'c9', 'wallet:c9', ${amount}, 'VND', ${status}, 0, ${now()}, ${now()})`.execute(db);
    await topup('REQUESTED', 100);
    await expect(topup('WEIRD', 100)).rejects.toMatchObject({ number: 547 });
    await expect(topup('REQUESTED', 0)).rejects.toMatchObject({ number: 547 });
  });

  it('treats idempotency keys as case-sensitive and scoped per customer', async () => {
    await insertAccount('wallet:c10', 'WALLET', 0);
    await sql`insert into ${t(acme, 'topups')}
      (id, customer_id, account_id, amount, currency, status, attempts, next_attempt_at, created_at)
      values ('tp_idem', 'c10', 'wallet:c10', 1, 'VND', 'REQUESTED', 0, ${now()}, ${now()})`.execute(db);
    const key = (customer: string, value: string) =>
      sql`insert into ${t(acme, 'idempotency_keys')}
        (customer_id, idempotency_key, request_hash, response_status, response_body, topup_id, created_at)
        values (${customer}, ${value}, 'h', 202, '{}', 'tp_idem', ${now()})`.execute(db);
    await key('c10', 'ABC');
    await key('c10', 'abc');
    await key('c11', 'ABC');
    await expect(key('c10', 'ABC')).rejects.toMatchObject({ number: 2627 });
  });

  it('rejects a repeated inbox message for the same consumer only', async () => {
    const inbox = (consumer: string, id: string) =>
      sql`insert into ${t(acme, 'processed_messages')} (consumer, message_id, processed_at)
        values (${consumer}, ${id}, ${now()})`.execute(db);
    await inbox('payment-webhook', 'evt_1');
    await inbox('other', 'evt_1');
    await expect(inbox('payment-webhook', 'evt_1')).rejects.toMatchObject({ number: 2627 });
  });
});
```

- [ ] **Step 6: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration provisioning`
Expected: FAIL (không resolve được `./provisioning.js`, `./schema-name.js`).

- [ ] **Step 7: Cài migration, provisioning và lệnh migrate**

`services/wallet/src/infrastructure/kysely/schema-name.ts`:
```ts
import type { TenantId } from '../../domain/tenant-id.js';

const SCHEMA = /^t_[a-z][a-z0-9-]{0,39}$/;

/** Tên schema của tenant. `TenantId` đã được kiểm tra nên tên này luôn an toàn khi quote. */
export function schemaName(tenant: TenantId): string {
  return `t_${tenant.value}`;
}

/** Chặn tên schema lạ trước khi dùng trong DDL hay SQL thô. */
export function assertSchemaName(schema: string): string {
  if (!SCHEMA.test(schema)) throw new Error(`invalid tenant schema name: ${schema}`);
  return schema;
}
```

`services/wallet/src/infrastructure/kysely/migrations/001-ledger.ts`:
```ts
import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Tài khoản, giao dịch và dòng bút toán; sổ cái bất biến bằng trigger. Chạy trong schema của một tenant. */
export const ledgerMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    await sql`
      create table ${t('accounts')} (
        id nvarchar(80) not null primary key,
        kind nvarchar(16) not null,
        customer_id nvarchar(64) null,
        currency nvarchar(3) not null,
        balance bigint not null,
        created_at datetime2(3) not null,
        constraint ck_accounts_kind check (kind in ('WALLET', 'GATEWAY', 'MERCHANT')),
        constraint ck_accounts_currency check (currency in ('VND', 'USD')),
        constraint ck_accounts_balance check (
          (kind = 'WALLET' and balance >= 0)
          or (kind = 'GATEWAY' and balance <= 0)
          or (kind = 'MERCHANT' and balance >= 0)
        )
      )`.execute(db);

    await sql`
      create table ${t('ledger_transactions')} (
        id nvarchar(64) not null primary key,
        business_key nvarchar(200) not null,
        kind nvarchar(16) not null,
        created_at datetime2(3) not null,
        constraint uq_ledger_transactions_business_key unique (business_key),
        constraint ck_ledger_transactions_kind check (kind in ('TOPUP'))
      )`.execute(db);

    await sql`
      create table ${t('ledger_entries')} (
        id bigint identity(1, 1) not null primary key,
        transaction_id nvarchar(64) not null references ${t('ledger_transactions')} (id),
        account_id nvarchar(80) not null references ${t('accounts')} (id),
        amount bigint not null,
        created_at datetime2(3) not null,
        constraint ck_ledger_entries_amount check (amount <> 0)
      )`.execute(db);
    await sql`create index ix_ledger_entries_account on ${t('ledger_entries')} (account_id, id)`.execute(db);
    await sql`create index ix_ledger_entries_transaction on ${t('ledger_entries')} (transaction_id)`.execute(db);

    // Sổ cái chỉ được ghi thêm: chặn sửa/xóa ở mức DB bất kể ai có quyền.
    for (const table of ['ledger_entries', 'ledger_transactions']) {
      await sql`
        create trigger ${t(`trg_${table}_immutable`)} on ${t(table)}
        instead of update, delete
        as begin
          throw 50001, 'ledger is immutable', 1;
        end`.execute(db);
    }

    // Tài khoản hệ thống theo từng đồng tiền.
    for (const currency of ['VND', 'USD']) {
      for (const kind of ['GATEWAY', 'MERCHANT']) {
        await sql`
          insert into ${t('accounts')} (id, kind, customer_id, currency, balance, created_at)
          values (${`system:${kind}:${currency}`}, ${kind}, null, ${currency}, 0,
                  cast(sysutcdatetime() as datetime2(3)))`.execute(db);
      }
    }
  },
});
```

`services/wallet/src/infrastructure/kysely/migrations/002-topups.ts`:
```ts
import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Lần nạp tiền, idempotency key của API và inbox khử trùng webhook. Chạy trong schema của một tenant. */
export const topupsMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    await sql`
      create table ${t('topups')} (
        id nvarchar(64) not null primary key,
        customer_id nvarchar(64) not null,
        account_id nvarchar(80) not null references ${t('accounts')} (id),
        amount bigint not null,
        currency nvarchar(3) not null,
        status nvarchar(16) not null,
        charge_id nvarchar(64) null,
        failure_code nvarchar(64) null,
        attempts int not null,
        next_attempt_at datetime2(3) null,
        created_at datetime2(3) not null,
        completed_at datetime2(3) null,
        constraint ck_topups_amount check (amount > 0),
        constraint ck_topups_currency check (currency in ('VND', 'USD')),
        constraint ck_topups_status check (status in ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED'))
      )`.execute(db);
    // Index (status, next_attempt_at, id) là BẮT BUỘC cho `top (1) ... with (updlock, readpast)` của worker.
    await sql`create index ix_topups_due on ${t('topups')} (status, next_attempt_at, id)`.execute(db);
    await sql`create index ix_topups_customer on ${t('topups')} (customer_id, created_at)`.execute(db);

    await sql`
      create table ${t('idempotency_keys')} (
        customer_id nvarchar(64) not null,
        idempotency_key nvarchar(255) collate Latin1_General_100_BIN2 not null,
        request_hash nvarchar(64) not null,
        response_status int not null,
        response_body nvarchar(max) not null,
        topup_id nvarchar(64) not null references ${t('topups')} (id),
        created_at datetime2(3) not null,
        primary key (customer_id, idempotency_key)
      )`.execute(db);

    await sql`
      create table ${t('processed_messages')} (
        consumer nvarchar(64) not null,
        message_id nvarchar(128) not null,
        processed_at datetime2(3) not null,
        primary key (consumer, message_id)
      )`.execute(db);
  },
});
```

`services/wallet/src/infrastructure/kysely/migrations/index.ts`:
```ts
import type { Migration } from '@billing/database';
import { assertSchemaName } from '../schema-name.js';
import { ledgerMigration } from './001-ledger.js';
import { topupsMigration } from './002-topups.js';

/** Các migration của một schema tenant. Tên quyết định thứ tự; chỉ thêm mới, không sửa cái đã phát hành. */
export function walletMigrations(schema: string): Record<string, Migration> {
  assertSchemaName(schema);
  return {
    '001-ledger': ledgerMigration(schema),
    '002-topups': topupsMigration(schema),
  };
}
```

`services/wallet/src/infrastructure/kysely/provisioning.ts`:
```ts
import { migrate, pendingMigrations } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import type { TenantId } from '../../domain/tenant-id.js';
import { walletMigrations } from './migrations/index.js';
import { assertSchemaName, schemaName } from './schema-name.js';

/**
 * Cấp phát từng tenant: tạo schema nếu chưa có rồi chạy migration trong schema đó (bảng theo dõi nằm
 * trong schema). Idempotent. Phải chạy bằng tài khoản thuộc `db_owner` (xem `migrate`).
 */
export async function provisionTenants(
  owner: Kysely<unknown>,
  tenants: readonly TenantId[],
): Promise<Record<string, string[]>> {
  const applied: Record<string, string[]> = {};
  for (const tenant of tenants) {
    const schema = assertSchemaName(schemaName(tenant));
    await sql
      .raw(
        `if not exists (select 1 from sys.schemas where name = '${schema}') exec('create schema [${schema}]')`,
      )
      .execute(owner);
    applied[tenant.value] = await migrate(owner, walletMigrations(schema), {
      migrationTableSchema: schema,
    });
  }
  return applied;
}

/** Khởi động an toàn: mọi tenant đã được cấp phát và migrate xong, nếu không thì ném lỗi nêu rõ tenant nào còn thiếu gì. */
export async function assertMigrated(
  db: Kysely<unknown>,
  tenants: readonly TenantId[],
): Promise<void> {
  const problems: string[] = [];
  for (const tenant of tenants) {
    const schema = assertSchemaName(schemaName(tenant));
    const pending = await pendingMigrations(db, walletMigrations(schema), {
      migrationTableSchema: schema,
    });
    if (pending.length > 0) {
      problems.push(`tenant "${tenant.value}" has pending migrations: ${pending.join(', ')}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`database is not migrated (run db:migrate:wallet): ${problems.join('; ')}`);
  }
}
```

`db/wallet/migrate.ts`:
```ts
import { ConfigError, createDatabase, migratorConfigFromEnv } from '@billing/database';
import { TenantId } from '../../services/wallet/src/domain/tenant-id.js';
import { provisionTenants } from '../../services/wallet/src/infrastructure/kysely/provisioning.js';

function parseTenants(raw: string | undefined): TenantId[] {
  const parts = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) throw new ConfigError(['WALLET_TENANTS is required']);
  return parts.map((part) => TenantId.parse(part));
}

try {
  // Migrator của Kysely cần tài khoản thuộc db_owner; tài khoản ứng dụng chỉ cần DML.
  const config = migratorConfigFromEnv('WALLET_DB', 'WALLET_MIGRATOR_DB', process.env);
  const tenants = parseTenants(process.env.WALLET_TENANTS);

  const db = createDatabase<unknown>(config);
  try {
    const applied = await provisionTenants(db, tenants);
    for (const [tenant, names] of Object.entries(applied)) {
      console.log(`${tenant}: ${names.length > 0 ? `applied ${names.join(', ')}` : 'up to date'}`);
    }
  } finally {
    await db.destroy();
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
```

Thêm vào `scripts` của `package.json` gốc, dưới `"db:migrate:payment"`:
```json
    "db:migrate:wallet": "tsx db/wallet/migrate.ts",
```

- [ ] **Step 8: Chạy test, lint, typecheck**

```bash
corepack pnpm test:integration provisioning database-schema
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS. Các test trong `provisioning.integration.test.ts` chạy bằng tài khoản `sa` của testcontainers (có `db_owner`), nên `Migrator` chạy được. Nếu `format:check` lệch, `corepack pnpm exec prettier --write` đúng các file mới.

- [ ] **Step 9: Thử lệnh migrate bằng tay với một DB thật (không có thì ghi rõ là chưa thử)**

Lệnh `db:migrate:wallet` đã được bao phủ gián tiếp qua `provisionTenants`; phần chỉ `migrate.ts` làm (đọc env, ghép user migrator) kiểm tra nhanh không cần DB:
```bash
corepack pnpm db:migrate:wallet
```
Expected: thoát mã `1` và in `Invalid configuration: WALLET_DB_HOST is required; ...` (thiếu cấu hình). Ghi kết quả vào báo cáo.

- [ ] **Step 10: Commit**

```bash
git add -A packages/database packages/testing services/wallet db package.json pnpm-lock.yaml
git commit -m "feat(wallet): per-tenant schema migrations, provisioning and db:migrate:wallet"
```

---

### Task 6: Port ứng dụng, repository Kysely, `TenantUnitOfWork` và harness

**Files:**
- Modify: `services/wallet/src/application/ports.ts` (viết lại: giữ `TenantRegistry`, thêm các port khác)
- Create: `services/wallet/src/infrastructure/kysely/schema.ts`, `mappers.ts`, `account.repository.ts`, `ledger.repository.ts`, `topup.repository.ts`, `idempotency.repository.ts`, `inbox.repository.ts`, `unit-of-work.ts`; `services/wallet/src/infrastructure/system.ts`; `services/wallet/src/test-support.ts`
- Test: `services/wallet/src/infrastructure/kysely/repositories.integration.test.ts`, `infrastructure/system.test.ts`

**Interfaces:**
- Consumes: domain (Task 3–4), `TenantRegistry`, `provisionTenants`, `schemaName`, lỗi `DuplicateKeyError` (Task 3, 5); `@billing/database`, `@billing/testing`.
- Produces (application/ports.ts):
  - `interface Clock { now(): Date }`; `interface IdGenerator { topupId(): string; transactionId(): string }`; `interface Logger { info(details: object, message?: string): void; warn(details: object, message?: string): void; error(details: object, message?: string): void }`
  - `interface AccountRepository { find(id: string): Promise<Account | null>; insert(account: Account): Promise<void> /* DuplicateKeyError nếu trùng id */; lockMany(ids: readonly string[]): Promise<Account[]> /* UPDLOCK từng tài khoản theo id tăng dần, trả về theo thứ tự đó, thiếu tài khoản → ném Error */; saveBalance(account: Account): Promise<void> }`
  - `interface LedgerEntryRecord { entryId: number; transactionId: string; businessKey: string; amount: number; createdAt: Date }`; `interface LedgerRepository { post(transaction: LedgerTransaction): Promise<void> /* DuplicateKeyError nếu trùng business_key */; listEntries(query: { accountId: string; afterEntryId: number | null; limit: number }): Promise<LedgerEntryRecord[]> /* tăng dần theo entryId */ }`
  - `interface TopupRepository { insert(topup: Topup): Promise<void>; findById(id: string): Promise<Topup | null>; lockById(id: string): Promise<Topup | null> /* UPDLOCK */; lockNextDue(now: Date): Promise<Topup | null> /* status REQUESTED, nextAttemptAt <= now, top 1, UPDLOCK+READPAST */; save(topup: Topup): Promise<void> }`
  - `interface StoredTopupResponse { customerId: string; key: string; requestHash: string; responseStatus: number; responseBody: string; topupId: string; createdAt: Date }`; `interface IdempotencyStore { find(customerId: string, key: string): Promise<StoredTopupResponse | null>; save(record: StoredTopupResponse): Promise<void> /* DuplicateKeyError nếu trùng */ }`
  - `interface Inbox { record(consumer: string, messageId: string, now: Date): Promise<void> /* DuplicateKeyError nếu đã có */ }`
  - `interface Repositories { accounts: AccountRepository; ledger: LedgerRepository; topups: TopupRepository; idempotency: IdempotencyStore; inbox: Inbox }`; `interface TenantUnitOfWork { run<T>(tenant: TenantId, work: (repositories: Repositories) => Promise<T>): Promise<T> }` (mỗi `run` là một transaction SQL; repository gắn với schema của tenant)
- Produces (infrastructure): `WalletDatabase` (kiểu bảng), `KyselyTenantUnitOfWork(db: Kysely<WalletDatabase>)`, `SystemClock`, `RandomIdGenerator` (`topupId()` = `tp_<32 hex>`, `transactionId()` = `tx_<32 hex>`)
- Produces (test): `createHarness(): Promise<Harness>` với `interface Harness { db: Kysely<WalletDatabase>; clock: FakeClock; ids: SequentialIds; uow: KyselyTenantUnitOfWork; registry: ConfigTenantRegistry; acme: TenantId; beta: TenantId; close(): Promise<void> }` (một database riêng đã cấp phát hai tenant `acme`, `beta`); `class SequentialIds implements IdGenerator` (`tp_000001`, `tx_000001`, …); `expectLedgerInvariants(h: Harness, tenant: TenantId): Promise<void>` kiểm tra: tổng số dư mọi tài khoản = 0, số dư của mỗi tài khoản = tổng các dòng của nó, tổng các dòng của mỗi giao dịch = 0

- [ ] **Step 1: Viết test thất bại**

`services/wallet/src/infrastructure/system.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { RandomIdGenerator, SystemClock } from './system.js';

describe('SystemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = new SystemClock().now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('RandomIdGenerator', () => {
  it('produces prefixed, unique identifiers', () => {
    const ids = new RandomIdGenerator();
    const topups = new Set(Array.from({ length: 50 }, () => ids.topupId()));
    expect(topups.size).toBe(50);
    for (const id of topups) expect(id).toMatch(/^tp_[0-9a-f]{32}$/);
    expect(ids.transactionId()).toMatch(/^tx_[0-9a-f]{32}$/);
  });
});
```

`services/wallet/src/infrastructure/kysely/repositories.integration.test.ts`:
```ts
import { Money } from '@billing/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '../../application/errors.js';
import { Account } from '../../domain/account.js';
import { CustomerId } from '../../domain/customer-id.js';
import { LedgerTransaction } from '../../domain/ledger-transaction.js';
import { Topup } from '../../domain/topup.js';
import { createHarness, type Harness } from '../../test-support.js';

const t0 = new Date('2026-10-10T10:00:00.000Z');
const plus = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const wallet = (customer: string, currency: 'VND' | 'USD' = 'VND', now = t0) =>
  Account.openWallet({ customerId: CustomerId.parse(customer), currency, now });

const requestTopup = (id: string, customer: string, amount: number, now = t0) =>
  Topup.request({
    id,
    customerId: CustomerId.parse(customer),
    accountId: `wallet:${customer}`,
    amount: Money.of(amount, 'VND'),
    now,
  });

describe('AccountRepository', () => {
  it('inserts and finds a wallet, round-tripping every field including milliseconds', async () => {
    const account = wallet('r1', 'USD', new Date('2026-10-10T10:00:00.007Z'));
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(account));
    const found = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:r1'));
    expect(found?.toProps()).toEqual(account.toProps());
    expect(await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:nope'))).toBeNull();
  });

  it('answers DuplicateKeyError for a second wallet of the same customer', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('r2')));
    const again = h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('r2', 'USD')));
    await expect(again).rejects.toBeInstanceOf(DuplicateKeyError);
  });

  it('finds the seeded system accounts', async () => {
    const gateway = await h.uow.run(h.acme, ({ accounts }) => accounts.find('system:GATEWAY:VND'));
    expect(gateway?.toProps()).toMatchObject({ kind: 'GATEWAY', currency: 'VND', customerId: null });
  });

  it('locks several accounts in ascending id order regardless of the order asked, and persists balances', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('r3')));
    const locked = await h.uow.run(h.acme, async ({ accounts }) => {
      const rows = await accounts.lockMany(['wallet:r3', 'system:GATEWAY:VND']);
      const [gateway, w] = rows;
      if (!gateway || !w) throw new Error('expected two accounts');
      await accounts.saveBalance(w.apply(Money.of(70, 'VND')));
      await accounts.saveBalance(gateway.apply(Money.of(-70, 'VND')));
      return rows.map((r) => r.toProps().id);
    });
    expect(locked).toEqual(['system:GATEWAY:VND', 'wallet:r3']);
    const after = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:r3'));
    expect(after?.toProps().balance.amount).toBe(70);
  });

  it('fails loudly when asked to lock an account that does not exist', async () => {
    const lock = h.uow.run(h.acme, ({ accounts }) => accounts.lockMany(['wallet:ghost']));
    await expect(lock).rejects.toThrow(/wallet:ghost/);
  });
});

describe('LedgerRepository', () => {
  it('posts a transaction with its entries and lists them in order with a keyset cursor', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('l1')));
    for (const [id, topupId, amount] of [['tx_l1', 'tp_l1', 100], ['tx_l2', 'tp_l2', 40]] as const) {
      await h.uow.run(h.acme, ({ ledger }) =>
        ledger.post(
          LedgerTransaction.topup({
            id,
            topupId,
            walletAccountId: 'wallet:l1',
            gatewayAccountId: 'system:GATEWAY:VND',
            amount: Money.of(amount, 'VND'),
            now: t0,
          }),
        ),
      );
    }
    const all = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 10 }),
    );
    expect(all.map((e) => [e.businessKey, e.amount])).toEqual([
      ['topup:tp_l1', 100],
      ['topup:tp_l2', 40],
    ]);
    expect(all[0]?.createdAt).toEqual(t0);

    const firstId = all[0]?.entryId ?? 0;
    const rest = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: firstId, limit: 10 }),
    );
    expect(rest.map((e) => e.businessKey)).toEqual(['topup:tp_l2']);
    const limited = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 1 }),
    );
    expect(limited).toHaveLength(1);
  });

  it('answers DuplicateKeyError for a second posting under the same business key and keeps nothing of it', async () => {
    const make = (id: string) =>
      LedgerTransaction.topup({
        id,
        topupId: 'tp_dup',
        walletAccountId: 'wallet:l1',
        gatewayAccountId: 'system:GATEWAY:VND',
        amount: Money.of(5, 'VND'),
        now: t0,
      });
    await h.uow.run(h.acme, ({ ledger }) => ledger.post(make('tx_d1')));
    const before = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 100 }),
    );
    await expect(h.uow.run(h.acme, ({ ledger }) => ledger.post(make('tx_d2')))).rejects.toBeInstanceOf(
      DuplicateKeyError,
    );
    const afterwards = await h.uow.run(h.acme, ({ ledger }) =>
      ledger.listEntries({ accountId: 'wallet:l1', afterEntryId: null, limit: 100 }),
    );
    expect(afterwards).toHaveLength(before.length);
  });
});

describe('TopupRepository', () => {
  it('round-trips a topup including milliseconds, null columns and a bigint amount', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('t1')));
    const topup = requestTopup('tp_t1', 't1', Number.MAX_SAFE_INTEGER, new Date('2026-10-10T10:00:00.003Z'));
    await h.uow.run(h.acme, ({ topups }) => topups.insert(topup));
    const found = await h.uow.run(h.acme, ({ topups }) => topups.findById('tp_t1'));
    expect(found?.toProps()).toEqual(topup.toProps());
    expect(await h.uow.run(h.acme, ({ topups }) => topups.findById('tp_none'))).toBeNull();
  });

  it('saves state transitions', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('t2')));
    const topup = requestTopup('tp_t2', 't2', 10);
    await h.uow.run(h.acme, ({ topups }) => topups.insert(topup));
    await h.uow.run(h.acme, ({ topups }) => topups.save(topup.recordSubmitted('ch_1')));
    const found = await h.uow.run(h.acme, ({ topups }) => topups.findById('tp_t2'));
    expect(found?.toProps()).toMatchObject({ status: 'PENDING', chargeId: 'ch_1', attempts: 1, nextAttemptAt: null });
  });

  it('lockNextDue() returns the oldest due REQUESTED topup and ignores the rest', async () => {
    for (const customer of ['n1', 'n2', 'n3', 'n4']) {
      await h.uow.run(h.beta, ({ accounts }) => accounts.insert(wallet(customer)));
    }
    await h.uow.run(h.beta, async ({ topups }) => {
      await topups.insert(requestTopup('tp_n1', 'n1', 1, plus(0)));
      await topups.insert(requestTopup('tp_n2', 'n2', 1, plus(5)));
      const pending = requestTopup('tp_n3', 'n3', 1, plus(0));
      await topups.insert(pending);
      await topups.save(pending.recordSubmitted('ch_n3'));
      await topups.insert(requestTopup('tp_n4', 'n4', 1, plus(100)));
    });
    const next = (now: Date) => h.uow.run(h.beta, ({ topups }) => topups.lockNextDue(now));
    expect((await next(plus(1)))?.toProps().id).toBe('tp_n1');
    expect((await next(plus(6)))?.toProps().id).toBe('tp_n1');
    expect(await h.uow.run(h.beta, ({ topups }) => topups.lockNextDue(new Date(t0.getTime() - 1)))).toBeNull();
  });

  it('lockNextDue() skips a topup another open transaction holds (READPAST)', async () => {
    for (const customer of ['p1', 'p2']) {
      await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet(customer)));
    }
    await h.uow.run(h.acme, async ({ topups }) => {
      await topups.insert(requestTopup('tp_p1', 'p1', 1, plus(-20)));
      await topups.insert(requestTopup('tp_p2', 'p2', 1, plus(-10)));
    });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: (id: string | undefined) => void;
    const lockedId = new Promise<string | undefined>((resolve) => (locked = resolve));

    const first = h.uow.run(h.acme, async ({ topups }) => {
      const row = await topups.lockNextDue(t0);
      locked(row?.toProps().id);
      await hold;
    });
    expect(await lockedId).toBe('tp_p1');

    const second = await h.uow.run(h.acme, ({ topups }) => topups.lockNextDue(t0));
    expect(second?.toProps().id).toBe('tp_p2');

    release();
    await first;
  });
});

describe('IdempotencyStore and Inbox', () => {
  it('stores and finds a response per customer and key, and rejects a duplicate key', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('i1')));
    await h.uow.run(h.acme, ({ topups }) => topups.insert(requestTopup('tp_i1', 'i1', 5)));
    const record = {
      customerId: 'i1',
      key: 'Key-1',
      requestHash: 'h'.repeat(64),
      responseStatus: 202,
      responseBody: '{"topupId":"tp_i1"}',
      topupId: 'tp_i1',
      createdAt: new Date('2026-10-10T10:00:00.123Z'),
    };
    await h.uow.run(h.acme, ({ idempotency }) => idempotency.save(record));
    expect(await h.uow.run(h.acme, ({ idempotency }) => idempotency.find('i1', 'Key-1'))).toEqual(record);
    expect(await h.uow.run(h.acme, ({ idempotency }) => idempotency.find('i1', 'key-1'))).toBeNull();
    expect(await h.uow.run(h.acme, ({ idempotency }) => idempotency.find('other', 'Key-1'))).toBeNull();
    await expect(h.uow.run(h.acme, ({ idempotency }) => idempotency.save(record))).rejects.toBeInstanceOf(
      DuplicateKeyError,
    );
  });

  it('records an inbox message once per consumer', async () => {
    await h.uow.run(h.acme, ({ inbox }) => inbox.record('payment-webhook', 'evt_1', t0));
    await expect(
      h.uow.run(h.acme, ({ inbox }) => inbox.record('payment-webhook', 'evt_1', t0)),
    ).rejects.toBeInstanceOf(DuplicateKeyError);
    await h.uow.run(h.acme, ({ inbox }) => inbox.record('another', 'evt_1', t0));
  });
});

describe('TenantUnitOfWork', () => {
  it('keeps tenants isolated: the same ids in acme and beta are different rows', async () => {
    await h.uow.run(h.acme, ({ accounts }) => accounts.insert(wallet('iso')));
    expect(await h.uow.run(h.beta, ({ accounts }) => accounts.find('wallet:iso'))).toBeNull();
    await h.uow.run(h.beta, ({ accounts }) => accounts.insert(wallet('iso', 'USD')));
    const inAcme = await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:iso'));
    const inBeta = await h.uow.run(h.beta, ({ accounts }) => accounts.find('wallet:iso'));
    expect(inAcme?.toProps().currency).toBe('VND');
    expect(inBeta?.toProps().currency).toBe('USD');
  });

  it('rolls everything back when the work throws', async () => {
    const failing = h.uow.run(h.acme, async ({ accounts }) => {
      await accounts.insert(wallet('rollback'));
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');
    expect(await h.uow.run(h.acme, ({ accounts }) => accounts.find('wallet:rollback'))).toBeNull();
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet/src/infrastructure/system.test.ts && corepack pnpm test:integration wallet/src/infrastructure/kysely/repositories`
Expected: FAIL (không resolve được `./system.js`, `../../test-support.js`).

- [ ] **Step 3: Cài port, kiểu bảng, mapper**

Viết lại toàn bộ `services/wallet/src/application/ports.ts`:
```ts
import type { Account } from '../domain/account.js';
import type { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { Topup } from '../domain/topup.js';

export interface TenantRegistry {
  /** Biến chuỗi thô (header, metadata) thành `TenantId` hợp lệ và có trong cấu hình. */
  resolve(raw: string | undefined): TenantId;
  all(): readonly TenantId[];
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  topupId(): string;
  transactionId(): string;
}

export interface Logger {
  info(details: object, message?: string): void;
  warn(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

export interface AccountRepository {
  find(id: string): Promise<Account | null>;
  /** Ném `DuplicateKeyError` nếu đã có tài khoản cùng id. */
  insert(account: Account): Promise<void>;
  /** Khóa (UPDLOCK) từng tài khoản theo thứ tự id tăng dần; trả về theo thứ tự đó; thiếu tài khoản thì ném lỗi. */
  lockMany(ids: readonly string[]): Promise<Account[]>;
  saveBalance(account: Account): Promise<void>;
}

export interface LedgerEntryRecord {
  entryId: number;
  transactionId: string;
  businessKey: string;
  amount: number;
  createdAt: Date;
}

export interface LedgerRepository {
  /** Ghi giao dịch và các dòng của nó. Ném `DuplicateKeyError` nếu `business_key` đã tồn tại. */
  post(transaction: LedgerTransaction): Promise<void>;
  /** Các dòng của một tài khoản, tăng dần theo `entryId`. */
  listEntries(query: {
    accountId: string;
    afterEntryId: number | null;
    limit: number;
  }): Promise<LedgerEntryRecord[]>;
}

export interface TopupRepository {
  insert(topup: Topup): Promise<void>;
  findById(id: string): Promise<Topup | null>;
  /** Đọc và khóa (UPDLOCK) lần nạp. */
  lockById(id: string): Promise<Topup | null>;
  /** Lần nạp `REQUESTED` đến hạn cũ nhất, khóa bằng UPDLOCK + READPAST (bỏ qua dòng đang bị khóa). */
  lockNextDue(now: Date): Promise<Topup | null>;
  save(topup: Topup): Promise<void>;
}

export interface StoredTopupResponse {
  customerId: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: string;
  topupId: string;
  createdAt: Date;
}

export interface IdempotencyStore {
  find(customerId: string, key: string): Promise<StoredTopupResponse | null>;
  /** Ném `DuplicateKeyError` nếu `(customerId, key)` đã tồn tại. */
  save(record: StoredTopupResponse): Promise<void>;
}

export interface Inbox {
  /** Ghi nhận đã xử lý message; ném `DuplicateKeyError` nếu `(consumer, messageId)` đã có. */
  record(consumer: string, messageId: string, now: Date): Promise<void>;
}

export interface Repositories {
  accounts: AccountRepository;
  ledger: LedgerRepository;
  topups: TopupRepository;
  idempotency: IdempotencyStore;
  inbox: Inbox;
}

export interface TenantUnitOfWork {
  /** Một transaction SQL trên schema của tenant; không có cách truy cập DB nào mà không có `TenantId`. */
  run<T>(tenant: TenantId, work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
```

`services/wallet/src/infrastructure/kysely/schema.ts`:
```ts
import type { ColumnType, Generated } from 'kysely';

export interface AccountsTable {
  id: string;
  kind: string;
  customer_id: string | null;
  currency: string;
  /** bigint: đọc về là chuỗi, ghi bằng number. */
  balance: ColumnType<string, number, number>;
  created_at: Date;
}

export interface LedgerTransactionsTable {
  id: string;
  business_key: string;
  kind: string;
  created_at: Date;
}

export interface LedgerEntriesTable {
  /** identity bigint: đọc về là chuỗi, không ghi. */
  id: Generated<string>;
  transaction_id: string;
  account_id: string;
  amount: ColumnType<string, number, number>;
  created_at: Date;
}

export interface TopupsTable {
  id: string;
  customer_id: string;
  account_id: string;
  amount: ColumnType<string, number, number>;
  currency: string;
  status: string;
  charge_id: string | null;
  failure_code: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
  completed_at: Date | null;
}

export interface IdempotencyKeysTable {
  customer_id: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  topup_id: string;
  created_at: Date;
}

export interface ProcessedMessagesTable {
  consumer: string;
  message_id: string;
  processed_at: Date;
}

/** Tên bảng không có schema: repository luôn dựng trên `db.withSchema('t_<tenant>')`. */
export interface WalletDatabase {
  accounts: AccountsTable;
  ledger_transactions: LedgerTransactionsTable;
  ledger_entries: LedgerEntriesTable;
  topups: TopupsTable;
  idempotency_keys: IdempotencyKeysTable;
  processed_messages: ProcessedMessagesTable;
}
```

`services/wallet/src/infrastructure/kysely/mappers.ts`:
```ts
import { dateTime, toSafeInteger } from '@billing/database';
import { Money, type Currency } from '@billing/money';
import type { Insertable, Selectable } from 'kysely';
import { Account, type AccountKind } from '../../domain/account.js';
import { Topup, type TopupStatus } from '../../domain/topup.js';
import type { AccountsTable, TopupsTable } from './schema.js';

/** `dateTime()` là biểu thức SQL; Kysely chấp nhận biểu thức ở mọi chỗ cần giá trị Date. */
export const sqlDate = (value: Date): Date => dateTime(value) as unknown as Date;
export const sqlDateOrNull = (value: Date | null): Date | null =>
  value === null ? null : sqlDate(value);

export function accountToRow(account: Account): Insertable<AccountsTable> {
  const p = account.toProps();
  return {
    id: p.id,
    kind: p.kind,
    customer_id: p.customerId,
    currency: p.currency,
    balance: p.balance.amount,
    created_at: sqlDate(p.createdAt),
  };
}

export function rowToAccount(row: Selectable<AccountsTable>): Account {
  const currency = row.currency as Currency;
  return Account.rehydrate({
    id: row.id,
    kind: row.kind as AccountKind,
    customerId: row.customer_id,
    currency,
    balance: Money.of(toSafeInteger(row.balance), currency),
    createdAt: row.created_at,
  });
}

export function topupToRow(topup: Topup): Insertable<TopupsTable> {
  const p = topup.toProps();
  return {
    id: p.id,
    customer_id: p.customerId,
    account_id: p.accountId,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: p.status,
    charge_id: p.chargeId,
    failure_code: p.failureCode,
    attempts: p.attempts,
    next_attempt_at: sqlDateOrNull(p.nextAttemptAt),
    created_at: sqlDate(p.createdAt),
    completed_at: sqlDateOrNull(p.completedAt),
  };
}

export function rowToTopup(row: Selectable<TopupsTable>): Topup {
  return Topup.rehydrate({
    id: row.id,
    customerId: row.customer_id,
    accountId: row.account_id,
    amount: Money.of(toSafeInteger(row.amount), row.currency as Currency),
    status: row.status as TopupStatus,
    chargeId: row.charge_id,
    failureCode: row.failure_code,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}
```

- [ ] **Step 4: Cài repository và unit of work**

`services/wallet/src/infrastructure/kysely/account.repository.ts`:
```ts
import { isUniqueViolation } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { AccountRepository } from '../../application/ports.js';
import type { Account } from '../../domain/account.js';
import { accountToRow, rowToAccount } from './mappers.js';
import type { AccountsTable, WalletDatabase } from './schema.js';

export class KyselyAccountRepository implements AccountRepository {
  /** `db` đã gắn schema tenant (`withSchema`); `schema` dùng cho các câu SQL thô. */
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async find(id: string): Promise<Account | null> {
    const row = await this.db.selectFrom('accounts').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? rowToAccount(row) : null;
  }

  async insert(account: Account): Promise<void> {
    try {
      await this.db.insertInto('accounts').values(accountToRow(account)).execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`account already exists: ${account.toProps().id}`);
      }
      throw error;
    }
  }

  async lockMany(ids: readonly string[]): Promise<Account[]> {
    // Khóa tuần tự theo id tăng dần: thứ tự cố định nên hai giao dịch chạm cùng ví không deadlock.
    const sorted = [...new Set(ids)].sort();
    const locked: Account[] = [];
    for (const id of sorted) {
      const result = await sql<Selectable<AccountsTable>>`
        select id, kind, customer_id, currency, balance, created_at
        from ${sql.id(this.schema, 'accounts')} with (updlock, rowlock)
        where id = ${id}`.execute(this.db);
      const row = result.rows[0];
      if (!row) throw new Error(`account not found: ${id}`);
      locked.push(rowToAccount(row));
    }
    return locked;
  }

  async saveBalance(account: Account): Promise<void> {
    const row = accountToRow(account);
    await this.db.updateTable('accounts').set({ balance: row.balance }).where('id', '=', row.id).execute();
  }
}
```

`services/wallet/src/infrastructure/kysely/ledger.repository.ts`:
```ts
import { isUniqueViolation, toSafeInteger } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { LedgerEntryRecord, LedgerRepository } from '../../application/ports.js';
import type { LedgerTransaction } from '../../domain/ledger-transaction.js';
import { sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async post(transaction: LedgerTransaction): Promise<void> {
    const p = transaction.toProps();
    try {
      await this.db
        .insertInto('ledger_transactions')
        .values({
          id: p.id,
          business_key: p.businessKey,
          kind: p.kind,
          created_at: sqlDate(p.createdAt),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`business key already posted: ${p.businessKey}`);
      }
      throw error;
    }
    await this.db
      .insertInto('ledger_entries')
      .values(
        p.entries.map((entry) => ({
          transaction_id: p.id,
          account_id: entry.accountId,
          amount: entry.amount.amount,
          created_at: sqlDate(p.createdAt),
        })),
      )
      .execute();
  }

  async listEntries(query: {
    accountId: string;
    afterEntryId: number | null;
    limit: number;
  }): Promise<LedgerEntryRecord[]> {
    let builder = this.db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_transactions as t', 't.id', 'e.transaction_id')
      .select(['e.id as entry_id', 'e.transaction_id', 't.business_key', 'e.amount', 'e.created_at'])
      .where('e.account_id', '=', query.accountId);
    if (query.afterEntryId !== null) {
      builder = builder.where('e.id', '>', String(query.afterEntryId));
    }
    const rows = await builder.orderBy('e.id').top(query.limit).execute();
    return rows.map((row) => ({
      entryId: toSafeInteger(row.entry_id),
      transactionId: row.transaction_id,
      businessKey: row.business_key,
      amount: toSafeInteger(row.amount),
      createdAt: row.created_at,
    }));
  }
}
```

`services/wallet/src/infrastructure/kysely/topup.repository.ts`:
```ts
import { dateTime } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { TopupRepository } from '../../application/ports.js';
import type { Topup } from '../../domain/topup.js';
import { rowToTopup, topupToRow } from './mappers.js';
import type { TopupsTable, WalletDatabase } from './schema.js';

const COLUMNS = sql.raw(
  'id, customer_id, account_id, amount, currency, status, charge_id, failure_code, attempts, next_attempt_at, created_at, completed_at',
);

export class KyselyTopupRepository implements TopupRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async insert(topup: Topup): Promise<void> {
    await this.db.insertInto('topups').values(topupToRow(topup)).execute();
  }

  async findById(id: string): Promise<Topup | null> {
    const row = await this.db.selectFrom('topups').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? rowToTopup(row) : null;
  }

  async lockById(id: string): Promise<Topup | null> {
    const result = await sql<Selectable<TopupsTable>>`
      select ${COLUMNS} from ${sql.id(this.schema, 'topups')} with (updlock, rowlock)
      where id = ${id}`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToTopup(row) : null;
  }

  async lockNextDue(now: Date): Promise<Topup | null> {
    // Cần index ix_topups_due (status, next_attempt_at, id) khớp ORDER BY để READPAST bỏ qua đúng dòng bị khóa.
    const result = await sql<Selectable<TopupsTable>>`
      select top (1) ${COLUMNS}
      from ${sql.id(this.schema, 'topups')} with (updlock, readpast, rowlock)
      where status = ${'REQUESTED'} and next_attempt_at <= ${dateTime(now)}
      order by next_attempt_at, id`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToTopup(row) : null;
  }

  async save(topup: Topup): Promise<void> {
    const row = topupToRow(topup);
    await this.db
      .updateTable('topups')
      .set({
        status: row.status,
        charge_id: row.charge_id ?? null,
        failure_code: row.failure_code ?? null,
        attempts: row.attempts,
        next_attempt_at: row.next_attempt_at ?? null,
        completed_at: row.completed_at ?? null,
      })
      .where('id', '=', row.id)
      .execute();
  }
}
```

`services/wallet/src/infrastructure/kysely/idempotency.repository.ts`:
```ts
import { isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { IdempotencyStore, StoredTopupResponse } from '../../application/ports.js';
import { sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async find(customerId: string, key: string): Promise<StoredTopupResponse | null> {
    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('customer_id', '=', customerId)
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (!row) return null;
    return {
      customerId: row.customer_id,
      key: row.idempotency_key,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      topupId: row.topup_id,
      createdAt: row.created_at,
    };
  }

  async save(record: StoredTopupResponse): Promise<void> {
    try {
      await this.db
        .insertInto('idempotency_keys')
        .values({
          customer_id: record.customerId,
          idempotency_key: record.key,
          request_hash: record.requestHash,
          response_status: record.responseStatus,
          response_body: record.responseBody,
          topup_id: record.topupId,
          created_at: sqlDate(record.createdAt),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`idempotency key already exists: ${record.key}`);
      }
      throw error;
    }
  }
}
```

`services/wallet/src/infrastructure/kysely/inbox.repository.ts`:
```ts
import { isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { Inbox } from '../../application/ports.js';
import { sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyInbox implements Inbox {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async record(consumer: string, messageId: string, now: Date): Promise<void> {
    try {
      await this.db
        .insertInto('processed_messages')
        .values({ consumer, message_id: messageId, processed_at: sqlDate(now) })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`message already processed: ${consumer}/${messageId}`);
      }
      throw error;
    }
  }
}
```

`services/wallet/src/infrastructure/kysely/unit-of-work.ts`:
```ts
import type { Kysely } from 'kysely';
import type { Repositories, TenantUnitOfWork } from '../../application/ports.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { KyselyAccountRepository } from './account.repository.js';
import { KyselyIdempotencyStore } from './idempotency.repository.js';
import { KyselyInbox } from './inbox.repository.js';
import { KyselyLedgerRepository } from './ledger.repository.js';
import type { WalletDatabase } from './schema.js';
import { assertSchemaName, schemaName } from './schema-name.js';
import { KyselyTopupRepository } from './topup.repository.js';

/** Mỗi `run` là một transaction SQL; mọi repository gắn với schema của tenant được truyền vào. */
export class KyselyTenantUnitOfWork implements TenantUnitOfWork {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  run<T>(tenant: TenantId, work: (repositories: Repositories) => Promise<T>): Promise<T> {
    const schema = assertSchemaName(schemaName(tenant));
    return this.db.transaction().execute((trx) => {
      const scoped = trx.withSchema(schema);
      return work({
        accounts: new KyselyAccountRepository(scoped, schema),
        ledger: new KyselyLedgerRepository(scoped),
        topups: new KyselyTopupRepository(scoped, schema),
        idempotency: new KyselyIdempotencyStore(scoped),
        inbox: new KyselyInbox(scoped),
      });
    });
  }
}
```

`services/wallet/src/infrastructure/system.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '../application/ports.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomIdGenerator implements IdGenerator {
  topupId(): string {
    return `tp_${randomUUID().replaceAll('-', '')}`;
  }

  transactionId(): string {
    return `tx_${randomUUID().replaceAll('-', '')}`;
  }
}
```

`services/wallet/src/test-support.ts`:
```ts
import { createDatabase } from '@billing/database';
import { FakeClock, createTestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { expect } from 'vitest';
import type { IdGenerator } from './application/ports.js';
import { TenantId } from './domain/tenant-id.js';
import { ConfigTenantRegistry } from './infrastructure/tenant-registry.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';
import { provisionTenants } from './infrastructure/kysely/provisioning.js';
import { schemaName } from './infrastructure/kysely/schema-name.js';
import { KyselyTenantUnitOfWork } from './infrastructure/kysely/unit-of-work.js';

/** Mã định danh tất định để test so sánh được: tp_000001, tx_000001, ... */
export class SequentialIds implements IdGenerator {
  #topups = 0;
  #transactions = 0;

  topupId(): string {
    return `tp_${String(++this.#topups).padStart(6, '0')}`;
  }

  transactionId(): string {
    return `tx_${String(++this.#transactions).padStart(6, '0')}`;
  }
}

export interface Harness {
  db: Kysely<WalletDatabase>;
  clock: FakeClock;
  ids: SequentialIds;
  uow: KyselyTenantUnitOfWork;
  registry: ConfigTenantRegistry;
  acme: TenantId;
  beta: TenantId;
  close(): Promise<void>;
}

/** Dựng một database riêng đã cấp phát hai tenant `acme` và `beta`. Chỉ dùng trong integration test (chạy bằng `sa`, có db_owner). */
export async function createHarness(start = '2026-10-10T10:00:00.000Z'): Promise<Harness> {
  const testDb = await createTestDatabase('wallet');
  const db = createDatabase<WalletDatabase>(testDb.config);
  const acme = TenantId.parse('acme');
  const beta = TenantId.parse('beta');
  await provisionTenants(db as unknown as Kysely<unknown>, [acme, beta]);
  return {
    db,
    clock: new FakeClock(start),
    ids: new SequentialIds(),
    uow: new KyselyTenantUnitOfWork(db),
    registry: new ConfigTenantRegistry([acme, beta]),
    acme,
    beta,
    async close() {
      await db.destroy();
      await testDb.drop();
    },
  };
}

/**
 * Bất biến của sổ cái một tenant: tổng số dư mọi tài khoản = 0; số dư mỗi tài khoản = tổng các dòng của nó;
 * tổng các dòng của mỗi giao dịch = 0.
 */
export async function expectLedgerInvariants(h: Harness, tenant: TenantId): Promise<void> {
  const schema = schemaName(tenant);
  const total = await sql<{ total: string | null }>`
    select sum(balance) as total from ${sql.id(schema, 'accounts')}`.execute(h.db);
  expect(Number(total.rows[0]?.total ?? 0), 'sum of all balances').toBe(0);

  const drift = await sql<{ id: string }>`
    select a.id from ${sql.id(schema, 'accounts')} a
    left join (select account_id, sum(amount) as total from ${sql.id(schema, 'ledger_entries')} group by account_id) e
      on e.account_id = a.id
    where a.balance <> coalesce(e.total, 0)`.execute(h.db);
  expect(drift.rows.map((r) => r.id), 'accounts whose balance differs from their entries').toEqual([]);

  const unbalanced = await sql<{ transaction_id: string }>`
    select transaction_id from ${sql.id(schema, 'ledger_entries')}
    group by transaction_id having sum(amount) <> 0`.execute(h.db);
  expect(unbalanced.rows.map((r) => r.transaction_id), 'unbalanced transactions').toEqual([]);
}
```

- [ ] **Step 5: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run services/wallet/src/infrastructure/system.test.ts
corepack pnpm test:integration wallet/src/infrastructure/kysely/repositories
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS, gồm ca READPAST (giao dịch thứ hai nhận `tp_p2` khi giao dịch đầu giữ `tp_p1`) và cô lập tenant. Nếu `trx.withSchema(...)` không khớp kiểu `Kysely<WalletDatabase>` ở `unit-of-work.ts`, ép kiểu tối thiểu `as unknown as Kysely<WalletDatabase>` ở đúng một chỗ và ghi vào báo cáo.

- [ ] **Step 6: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): add ports, tenant-scoped Kysely repositories, unit of work and test harness"
```

### Task 7: `CreateWallet`, `GetWallet`, `ListEntries`

**Files:**
- Create: `services/wallet/src/application/views.ts`, `application/create-wallet.ts`, `application/get-wallet.ts`, `application/list-entries.ts`
- Test: `services/wallet/src/application/create-wallet.integration.test.ts`, `application/get-wallet.integration.test.ts`, `application/list-entries.integration.test.ts`

**Interfaces:**
- Consumes: `TenantUnitOfWork`, `Clock`, `Repositories` (Task 6); `Account`, `CustomerId`, `TenantId`, `LedgerTransaction` (Task 3–4); lỗi `WalletNotFoundError`, `WalletCurrencyConflictError`, `InvalidQueryError`, `DuplicateKeyError` (Task 3).
- Produces (`application/views.ts`):
  - `interface WalletView { customerId: string; currency: string; balance: number; createdAt: string }`; `toWalletView(account: Account): WalletView`
  - `interface TopupCreatedView { topupId: string; status: 'REQUESTED'; amount: number; currency: string; createdAt: string }`; `toTopupCreatedView(topup: Topup): TopupCreatedView`
  - `interface TopupView { topupId: string; status: TopupStatus; amount: number; currency: string; failureCode?: string; createdAt: string; completedAt?: string }`; `toTopupView(topup: Topup): TopupView`
  - `interface EntryView { entryId: number; transactionId: string; businessKey: string; amount: number; createdAt: string }`; `toEntryView(record: LedgerEntryRecord): EntryView`
- Produces (use case):
  - `CreateWallet({ uow, clock }).execute(input: { tenant: TenantId; customerId: CustomerId; currency: string }): Promise<{ created: boolean; wallet: WalletView }>` — ví mới → `created: true`; đã có cùng đồng tiền → `created: false` (trả ví đó); khác đồng tiền → `WalletCurrencyConflictError`; đồng tiền không hỗ trợ → `InvalidMoneyError` (từ `@billing/money`); hai lần tạo đồng thời → đúng một ví (bên thua vấp `DuplicateKeyError`, chạy lại một lần và thấy ví của bên thắng)
  - `GetWallet({ uow }).execute(input: { tenant: TenantId; customerId: CustomerId }): Promise<WalletView>` — không có → `WalletNotFoundError`
  - `ListEntries({ uow }).execute(input: { tenant: TenantId; customerId: CustomerId; limit?: number; cursor?: string }): Promise<{ items: EntryView[]; nextCursor: string | null }>` — `limit` mặc định 100, số nguyên `1..1000`; `cursor` khớp `^\d{1,18}$` (là `entryId` của dòng cuối trang trước, dưới dạng chuỗi); sai → `InvalidQueryError`; ví chưa có → `WalletNotFoundError`; lấy dư một dòng để biết còn trang sau (`nextCursor = null` khi hết)

- [ ] **Step 1: Viết test thất bại**

`services/wallet/src/application/create-wallet.integration.test.ts`:
```ts
import { InvalidMoneyError } from '@billing/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { WalletCurrencyConflictError } from './errors.js';

let h: Harness;
let createWallet: CreateWallet;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});

const walletRows = (schema: string) => h.db.withSchema(schema).selectFrom('accounts').selectAll().where('kind', '=', 'WALLET').execute();

describe('CreateWallet', () => {
  it('creates an empty wallet and reports it as created', async () => {
    const result = await createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w1'), currency: 'VND' });
    expect(result).toEqual({
      created: true,
      wallet: { customerId: 'w1', currency: 'VND', balance: 0, createdAt: '2026-10-10T10:00:00.000Z' },
    });
  });

  it('is idempotent for the same customer and currency', async () => {
    const input = { tenant: h.acme, customerId: CustomerId.parse('w2'), currency: 'USD' };
    const first = await createWallet.execute(input);
    h.clock.advanceSeconds(30);
    const again = await createWallet.execute(input);
    expect(first.created).toBe(true);
    expect(again).toEqual({ created: false, wallet: first.wallet });
  });

  it('refuses a second wallet in another currency for the same customer', async () => {
    await createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w3'), currency: 'VND' });
    await expect(
      createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w3'), currency: 'USD' }),
    ).rejects.toBeInstanceOf(WalletCurrencyConflictError);
  });

  it('rejects an unsupported currency and persists nothing', async () => {
    await expect(
      createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w4'), currency: 'EUR' }),
    ).rejects.toBeInstanceOf(InvalidMoneyError);
    const rows = await walletRows('t_acme');
    expect(rows.find((r) => r.id === 'wallet:w4')).toBeUndefined();
  });

  it('creates exactly one wallet when the same customer is created concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w5'), currency: 'VND' }),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await walletRows('t_acme')).filter((r) => r.id === 'wallet:w5')).toHaveLength(1);
  });

  it('gives the same customer id an independent wallet in each tenant', async () => {
    const inAcme = await createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('w6'), currency: 'VND' });
    const inBeta = await createWallet.execute({ tenant: h.beta, customerId: CustomerId.parse('w6'), currency: 'USD' });
    expect(inAcme.created && inBeta.created).toBe(true);
    expect(inAcme.wallet.currency).toBe('VND');
    expect(inBeta.wallet.currency).toBe('USD');
  });
});
```

`services/wallet/src/application/get-wallet.integration.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { WalletNotFoundError } from './errors.js';
import { GetWallet } from './get-wallet.js';

let h: Harness;
let createWallet: CreateWallet;
let getWallet: GetWallet;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  getWallet = new GetWallet({ uow: h.uow });
});
afterAll(async () => {
  await h.close();
});

describe('GetWallet', () => {
  it('returns the wallet of the caller', async () => {
    await createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('g1'), currency: 'VND' });
    expect(await getWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('g1') })).toEqual({
      customerId: 'g1',
      currency: 'VND',
      balance: 0,
      createdAt: '2026-10-10T10:00:00.000Z',
    });
  });

  it('answers WalletNotFoundError for a customer without a wallet', async () => {
    await expect(getWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('nobody') })).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });

  it('does not see a wallet that belongs to another tenant', async () => {
    await createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('g2'), currency: 'VND' });
    await expect(getWallet.execute({ tenant: h.beta, customerId: CustomerId.parse('g2') })).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});
```

`services/wallet/src/application/list-entries.integration.test.ts`:
```ts
import { Money } from '@billing/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { InvalidQueryError, WalletNotFoundError } from './errors.js';
import { ListEntries } from './list-entries.js';

let h: Harness;
let createWallet: CreateWallet;
let listEntries: ListEntries;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  listEntries = new ListEntries({ uow: h.uow });
  await createWallet.execute({ tenant: h.acme, customerId: CustomerId.parse('e1'), currency: 'VND' });
  for (const [index, amount] of [100, 200, 300].entries()) {
    await h.uow.run(h.acme, ({ ledger }) =>
      ledger.post(
        LedgerTransaction.topup({
          id: `tx_e${index}`,
          topupId: `tp_e${index}`,
          walletAccountId: 'wallet:e1',
          gatewayAccountId: 'system:GATEWAY:VND',
          amount: Money.of(amount, 'VND'),
          now: h.clock.now(),
        }),
      ),
    );
  }
});
afterAll(async () => {
  await h.close();
});

const customerId = CustomerId.parse('e1');
const query = (extra: { limit?: number; cursor?: string } = {}) => ({ tenant: h.acme, customerId, ...extra });

describe('ListEntries', () => {
  it('lists the wallet entries in order with the business key of each transaction', async () => {
    const page = await listEntries.execute(query());
    expect(page.items.map((i) => [i.businessKey, i.amount])).toEqual([
      ['topup:tp_e0', 100],
      ['topup:tp_e1', 200],
      ['topup:tp_e2', 300],
    ]);
    expect(page.items[0]).toMatchObject({ transactionId: 'tx_e0', createdAt: '2026-10-10T10:00:00.000Z' });
    expect(page.nextCursor).toBeNull();
  });

  it('walks the whole list one entry at a time without skipping or repeating', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 10; step++) {
      const page = await listEntries.execute(query({ limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
      seen.push(...page.items.map((i) => i.businessKey));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(['topup:tp_e0', 'topup:tp_e1', 'topup:tp_e2']);
  });

  it('has no next page when the limit exactly matches the number of entries', async () => {
    const page = await listEntries.execute(query({ limit: 3 }));
    expect(page.items).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });

  it.each([0, 1001, 1.5, Number.NaN, -1])('rejects the invalid limit %d', async (limit) => {
    await expect(listEntries.execute(query({ limit }))).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it.each(['abc', '-1', '1.5', '', '1234567890123456789', ' 1'])('rejects the invalid cursor %j', async (cursor) => {
    await expect(listEntries.execute(query({ cursor }))).rejects.toBeInstanceOf(InvalidQueryError);
  });

  it('answers WalletNotFoundError when the customer has no wallet, and does not leak across tenants', async () => {
    await expect(
      listEntries.execute({ tenant: h.acme, customerId: CustomerId.parse('nobody') }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    await expect(listEntries.execute({ tenant: h.beta, customerId: CustomerId.parse('e1') })).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration create-wallet get-wallet list-entries`
Expected: FAIL (không resolve được các module use case).

- [ ] **Step 3: Cài view và use case**

`services/wallet/src/application/views.ts`:
```ts
import type { Account } from '../domain/account.js';
import type { Topup, TopupStatus } from '../domain/topup.js';
import type { LedgerEntryRecord } from './ports.js';

export interface WalletView {
  customerId: string;
  currency: string;
  balance: number;
  createdAt: string;
}

export function toWalletView(account: Account): WalletView {
  const p = account.toProps();
  return {
    customerId: p.customerId ?? '',
    currency: p.currency,
    balance: p.balance.amount,
    createdAt: p.createdAt.toISOString(),
  };
}

export interface TopupCreatedView {
  topupId: string;
  status: 'REQUESTED';
  amount: number;
  currency: string;
  createdAt: string;
}

export function toTopupCreatedView(topup: Topup): TopupCreatedView {
  const p = topup.toProps();
  return {
    topupId: p.id,
    status: 'REQUESTED',
    amount: p.amount.amount,
    currency: p.amount.currency,
    createdAt: p.createdAt.toISOString(),
  };
}

export interface TopupView {
  topupId: string;
  status: TopupStatus;
  amount: number;
  currency: string;
  failureCode?: string;
  createdAt: string;
  completedAt?: string;
}

export function toTopupView(topup: Topup): TopupView {
  const p = topup.toProps();
  return {
    topupId: p.id,
    status: p.status,
    amount: p.amount.amount,
    currency: p.amount.currency,
    ...(p.failureCode === null ? {} : { failureCode: p.failureCode }),
    createdAt: p.createdAt.toISOString(),
    ...(p.completedAt === null ? {} : { completedAt: p.completedAt.toISOString() }),
  };
}

export interface EntryView {
  entryId: number;
  transactionId: string;
  businessKey: string;
  amount: number;
  createdAt: string;
}

export function toEntryView(record: LedgerEntryRecord): EntryView {
  return {
    entryId: record.entryId,
    transactionId: record.transactionId,
    businessKey: record.businessKey,
    amount: record.amount,
    createdAt: record.createdAt.toISOString(),
  };
}
```

`services/wallet/src/application/create-wallet.ts`:
```ts
import { Money, type Currency } from '@billing/money';
import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { DuplicateKeyError, WalletCurrencyConflictError } from './errors.js';
import type { Clock, TenantUnitOfWork } from './ports.js';
import { toWalletView, type WalletView } from './views.js';

export interface CreateWalletInput {
  tenant: TenantId;
  customerId: CustomerId;
  currency: string;
}

export interface CreateWalletResult {
  created: boolean;
  wallet: WalletView;
}

export class CreateWallet {
  constructor(private readonly deps: { uow: TenantUnitOfWork; clock: Clock }) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    // Money.zero ném InvalidMoneyError với đồng tiền không được hỗ trợ.
    const currency = Money.zero(input.currency as Currency).currency;

    const attempt = (): Promise<CreateWalletResult> =>
      this.deps.uow.run(input.tenant, async ({ accounts }) => {
        const existing = await accounts.find(Account.walletId(input.customerId));
        if (existing) {
          if (existing.toProps().currency !== currency) {
            throw new WalletCurrencyConflictError(
              `customer already has a wallet in ${existing.toProps().currency}`,
            );
          }
          return { created: false, wallet: toWalletView(existing) };
        }
        const wallet = Account.openWallet({
          customerId: input.customerId,
          currency,
          now: this.deps.clock.now(),
        });
        await accounts.insert(wallet);
        return { created: true, wallet: toWalletView(wallet) };
      });

    try {
      return await attempt();
    } catch (error) {
      // Hai lần tạo đồng thời: bên thua vấp khóa chính (giao dịch đã rollback); chạy lại một lần để thấy ví của bên thắng.
      if (error instanceof DuplicateKeyError) return await attempt();
      throw error;
    }
  }
}
```

`services/wallet/src/application/get-wallet.ts`:
```ts
import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { WalletNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toWalletView, type WalletView } from './views.js';

export class GetWallet {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: { tenant: TenantId; customerId: CustomerId }): Promise<WalletView> {
    const wallet = await this.deps.uow.run(input.tenant, ({ accounts }) =>
      accounts.find(Account.walletId(input.customerId)),
    );
    if (!wallet) throw new WalletNotFoundError('wallet not found');
    return toWalletView(wallet);
  }
}
```

`services/wallet/src/application/list-entries.ts`:
```ts
import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { InvalidQueryError, WalletNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toEntryView, type EntryView } from './views.js';

export const DEFAULT_ENTRIES_LIMIT = 100;
export const MAX_ENTRIES_LIMIT = 1000;
const CURSOR = /^\d{1,18}$/;

export interface ListEntriesInput {
  tenant: TenantId;
  customerId: CustomerId;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListEntriesResult {
  items: EntryView[];
  nextCursor: string | null;
}

export class ListEntries {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: ListEntriesInput): Promise<ListEntriesResult> {
    const limit = input.limit ?? DEFAULT_ENTRIES_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ENTRIES_LIMIT) {
      throw new InvalidQueryError(`limit must be an integer in 1..${MAX_ENTRIES_LIMIT}`);
    }
    let afterEntryId: number | null = null;
    if (input.cursor !== undefined) {
      if (!CURSOR.test(input.cursor)) throw new InvalidQueryError('cursor is invalid');
      afterEntryId = Number(input.cursor);
    }

    const accountId = Account.walletId(input.customerId);
    const records = await this.deps.uow.run(input.tenant, async ({ accounts, ledger }) => {
      if (!(await accounts.find(accountId))) throw new WalletNotFoundError('wallet not found');
      // Lấy dư một dòng để biết còn trang sau hay không.
      return ledger.listEntries({ accountId, afterEntryId, limit: limit + 1 });
    });

    const page = records.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toEntryView),
      nextCursor: records.length > limit && last ? String(last.entryId) : null,
    };
  }
}
```
- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm test:integration create-wallet get-wallet list-entries && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check`
Expected: PASS (gồm ca 5 lần tạo ví đồng thời chỉ ra đúng 1 ví).

- [ ] **Step 5: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): add CreateWallet, GetWallet and ListEntries use cases"
```

---

### Task 8: `RequestTopup` và `GetTopup`

**Files:**
- Modify: `services/wallet/src/application/ports.ts` (thêm port `TopupSubmitter`)
- Create: `services/wallet/src/application/request-topup.ts`, `application/get-topup.ts`
- Test: `services/wallet/src/application/request-topup.integration.test.ts`, `application/get-topup.integration.test.ts`

**Interfaces:**
- Consumes: `Topup`, `Account`, `CustomerId`, `TenantId` (Task 3–4); `TenantUnitOfWork`, `Clock`, `IdGenerator`; views (Task 7); lỗi `WalletNotFoundError`, `IdempotencyConflictError`, `TopupNotFoundError`, `DuplicateKeyError`.
- Produces:
  - port `interface TopupSubmitter { submitSoon(tenant: TenantId, topupId: string): void }` (không chờ; mọi lỗi do bên cài đặt tự xử lý)
  - `RequestTopup({ uow, clock, ids, submitter }).execute(input: { tenant: TenantId; customerId: CustomerId; idempotencyKey: string; amount: number }): Promise<{ status: 202; body: TopupCreatedView; replayed: boolean }>` — kiểm tra ví tồn tại (`WalletNotFoundError`); `amount` là số nguyên minor unit của đồng tiền của ví (`InvalidMoneyError` nếu không nguyên, `InvalidTopupError` nếu `< 1`); ghi `REQUESTED` (`next_attempt_at = now`) và idempotency record trong **một** transaction; **sau khi commit** gọi `submitter.submitSoon` đúng một lần cho lần tạo mới (không gọi khi replay); cùng `(customer, key)` + cùng nội dung → trả đúng phản hồi `202` đã lưu, `replayed: true`; nội dung khác → `IdempotencyConflictError`; hai lần gọi đồng thời cùng key tạo đúng một lần nạp (bên thua gặp `DuplicateKeyError` và chạy lại một lần để nhận replay). Hash nội dung = sha256 của JSON `{ amount, currency }` (currency lấy từ ví)
  - `GetTopup({ uow }).execute(input: { tenant: TenantId; customerId: CustomerId; topupId: string }): Promise<TopupView>` — không có hoặc thuộc khách khác → `TopupNotFoundError`

- [ ] **Step 1: Viết test thất bại**

`services/wallet/src/application/request-topup.integration.test.ts`:
```ts
import { InvalidMoneyError } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { InvalidTopupError } from '../domain/errors.js';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { IdempotencyConflictError, WalletNotFoundError } from './errors.js';
import type { TopupSubmitter } from './ports.js';
import { RequestTopup } from './request-topup.js';

class RecordingSubmitter implements TopupSubmitter {
  readonly calls: Array<{ tenant: string; topupId: string }> = [];
  submitSoon(tenant: TenantId, topupId: string): void {
    this.calls.push({ tenant: tenant.value, topupId });
  }
}

let h: Harness;
let createWallet: CreateWallet;
let requestTopup: RequestTopup;
let submitter: RecordingSubmitter;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  submitter = new RecordingSubmitter();
  requestTopup = new RequestTopup({ uow: h.uow, clock: h.clock, ids: h.ids, submitter });
  h.clock.set('2026-10-10T10:00:00.000Z');
});

const cust = (id: string) => CustomerId.parse(id);
const openWallet = (tenant: TenantId, customer: string, currency = 'VND') =>
  createWallet.execute({ tenant, customerId: cust(customer), currency });
const request = (customer: string, key: string, amount: number, tenant = h.acme) =>
  requestTopup.execute({ tenant, customerId: cust(customer), idempotencyKey: key, amount });
const topupRows = (schema: string) => h.db.withSchema(schema).selectFrom('topups').selectAll().execute();

describe('RequestTopup', () => {
  it('records a REQUESTED topup due immediately and triggers one submission after the commit', async () => {
    await openWallet(h.acme, 'r1');
    const result = await request('r1', 'key-1', 150000);
    expect(result).toMatchObject({
      status: 202,
      replayed: false,
      body: { status: 'REQUESTED', amount: 150000, currency: 'VND', createdAt: '2026-10-10T10:00:00.000Z' },
    });
    const rows = (await topupRows('t_acme')).filter((r) => r.customer_id === 'r1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.body.topupId,
      account_id: 'wallet:r1',
      status: 'REQUESTED',
      attempts: 0,
      next_attempt_at: new Date('2026-10-10T10:00:00.000Z'),
    });
    expect(submitter.calls).toEqual([{ tenant: 'acme', topupId: result.body.topupId }]);
  });

  it('replays the stored 202 for the same key and content, without a second topup or submission', async () => {
    await openWallet(h.acme, 'r2');
    const first = await request('r2', 'key-1', 500);
    h.clock.advanceSeconds(30);
    const replay = await request('r2', 'key-1', 500);
    expect(replay).toMatchObject({ status: 202, replayed: true });
    expect(replay.body).toEqual(first.body);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r2')).toHaveLength(1);
    expect(submitter.calls).toHaveLength(1);
  });

  it('answers a conflict when the same key carries a different amount', async () => {
    await openWallet(h.acme, 'r3');
    await request('r3', 'key-1', 500);
    await expect(request('r3', 'key-1', 501)).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r3')).toHaveLength(1);
  });

  it('treats keys as case-sensitive and scoped per customer', async () => {
    await openWallet(h.acme, 'r4');
    await openWallet(h.acme, 'r5');
    await request('r4', 'Key', 10);
    await request('r4', 'key', 10);
    await request('r5', 'Key', 10);
    expect((await topupRows('t_acme')).filter((r) => ['r4', 'r5'].includes(r.customer_id))).toHaveLength(3);
  });

  it('creates exactly one topup and one submission when the same key arrives concurrently', async () => {
    await openWallet(h.acme, 'r6');
    const results = await Promise.all(Array.from({ length: 5 }, () => request('r6', 'key-1', 700)));
    expect(new Set(results.map((r) => r.body.topupId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r6')).toHaveLength(1);
    expect(submitter.calls).toHaveLength(1);
  });

  it('answers WalletNotFoundError when the customer has no wallet', async () => {
    await expect(request('ghost', 'key-1', 10)).rejects.toBeInstanceOf(WalletNotFoundError);
    expect(submitter.calls).toHaveLength(0);
  });

  it('keeps tenants apart: the same customer and key in two tenants are independent', async () => {
    await openWallet(h.acme, 'r7', 'VND');
    await openWallet(h.beta, 'r7', 'USD');
    const inAcme = await request('r7', 'key-1', 10, h.acme);
    const inBeta = await request('r7', 'key-1', 10, h.beta);
    expect(inAcme.body.currency).toBe('VND');
    expect(inBeta.body.currency).toBe('USD');
    expect(inAcme.body.topupId).not.toBe(inBeta.body.topupId);
    expect(inAcme.replayed || inBeta.replayed).toBe(false);
  });

  it.each([
    ['a fractional amount', 10.5, InvalidMoneyError],
    ['zero', 0, InvalidTopupError],
    ['a negative amount', -5, InvalidTopupError],
  ])('rejects %s and persists nothing', async (_name, amount, errorType) => {
    await openWallet(h.acme, 'r8');
    await expect(request('r8', `key-${String(amount)}`, amount)).rejects.toBeInstanceOf(errorType);
    expect((await topupRows('t_acme')).filter((r) => r.customer_id === 'r8')).toHaveLength(0);
    expect(submitter.calls).toHaveLength(0);
  });
});
```

`services/wallet/src/application/get-topup.integration.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import { TopupNotFoundError } from './errors.js';
import { GetTopup } from './get-topup.js';
import { RequestTopup } from './request-topup.js';

let h: Harness;
let requestTopup: RequestTopup;
let getTopup: GetTopup;

beforeAll(async () => {
  h = await createHarness();
  const createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  requestTopup = new RequestTopup({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    submitter: { submitSoon: () => undefined },
  });
  getTopup = new GetTopup({ uow: h.uow });
  for (const [tenant, customer] of [[h.acme, 'g1'], [h.acme, 'g2'], [h.beta, 'g1']] as const) {
    await createWallet.execute({ tenant, customerId: CustomerId.parse(customer), currency: 'VND' });
  }
});
afterAll(async () => {
  await h.close();
});

describe('GetTopup', () => {
  it('shows the topup of the caller without completion fields while it is REQUESTED', async () => {
    const { body } = await requestTopup.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g1'),
      idempotencyKey: 'k',
      amount: 900,
    });
    expect(
      await getTopup.execute({ tenant: h.acme, customerId: CustomerId.parse('g1'), topupId: body.topupId }),
    ).toStrictEqual({
      topupId: body.topupId,
      status: 'REQUESTED',
      amount: 900,
      currency: 'VND',
      createdAt: '2026-10-10T10:00:00.000Z',
    });
  });

  it('hides another customer\'s topup and an unknown id behind the same error', async () => {
    const { body } = await requestTopup.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g1'),
      idempotencyKey: 'k2',
      amount: 5,
    });
    await expect(
      getTopup.execute({ tenant: h.acme, customerId: CustomerId.parse('g2'), topupId: body.topupId }),
    ).rejects.toBeInstanceOf(TopupNotFoundError);
    await expect(
      getTopup.execute({ tenant: h.acme, customerId: CustomerId.parse('g1'), topupId: 'tp_nope' }),
    ).rejects.toBeInstanceOf(TopupNotFoundError);
  });

  it('does not see a topup that belongs to another tenant, even for the same customer id', async () => {
    const { body } = await requestTopup.execute({
      tenant: h.acme,
      customerId: CustomerId.parse('g1'),
      idempotencyKey: 'k3',
      amount: 5,
    });
    await expect(
      getTopup.execute({ tenant: h.beta, customerId: CustomerId.parse('g1'), topupId: body.topupId }),
    ).rejects.toBeInstanceOf(TopupNotFoundError);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration request-topup get-topup`
Expected: FAIL (không resolve được `./request-topup.js`, `./get-topup.js`, thiếu `TopupSubmitter`).

- [ ] **Step 3: Cài port và use case**

Thêm vào **cuối** `services/wallet/src/application/ports.ts`:
```ts

export interface TopupSubmitter {
  /** Kích hoạt một lần thử gửi lần nạp sang payment và trả về ngay (không chờ). Bên cài đặt tự xử lý lỗi. */
  submitSoon(tenant: TenantId, topupId: string): void;
}
```

`services/wallet/src/application/request-topup.ts`:
```ts
import { createHash } from 'node:crypto';
import { Money } from '@billing/money';
import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { Topup } from '../domain/topup.js';
import { DuplicateKeyError, IdempotencyConflictError, WalletNotFoundError } from './errors.js';
import type {
  Clock,
  IdGenerator,
  StoredTopupResponse,
  TenantUnitOfWork,
  TopupSubmitter,
} from './ports.js';
import { toTopupCreatedView, type TopupCreatedView } from './views.js';

export interface RequestTopupInput {
  tenant: TenantId;
  customerId: CustomerId;
  idempotencyKey: string;
  amount: number;
}

export interface RequestTopupResult {
  status: 202;
  body: TopupCreatedView;
  replayed: boolean;
}

const ACCEPTED = 202;

export class RequestTopup {
  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      clock: Clock;
      ids: IdGenerator;
      submitter: TopupSubmitter;
    },
  ) {}

  async execute(input: RequestTopupInput): Promise<RequestTopupResult> {
    const attempt = (): Promise<RequestTopupResult> =>
      this.deps.uow.run(input.tenant, async ({ accounts, topups, idempotency }) => {
        const wallet = await accounts.find(Account.walletId(input.customerId));
        if (!wallet) throw new WalletNotFoundError('wallet not found');

        const amount = Money.of(input.amount, wallet.toProps().currency);
        const requestHash = createHash('sha256')
          .update(JSON.stringify({ amount: amount.amount, currency: amount.currency }))
          .digest('hex');

        const existing = await idempotency.find(input.customerId.value, input.idempotencyKey);
        if (existing) return this.replay(existing, requestHash);

        const now = this.deps.clock.now();
        const topup = Topup.request({
          id: this.deps.ids.topupId(),
          customerId: input.customerId,
          accountId: wallet.toProps().id,
          amount,
          now,
        });
        const body = toTopupCreatedView(topup);
        await topups.insert(topup);
        await idempotency.save({
          customerId: input.customerId.value,
          key: input.idempotencyKey,
          requestHash,
          responseStatus: ACCEPTED,
          responseBody: JSON.stringify(body),
          topupId: body.topupId,
          createdAt: now,
        });
        return { status: ACCEPTED, body, replayed: false };
      });

    let result: RequestTopupResult;
    try {
      result = await attempt();
    } catch (error) {
      // Hai request đồng thời cùng key: bên thua vấp khóa chính (giao dịch đã rollback);
      // chạy lại một lần sẽ thấy bản ghi của bên thắng và trả về replay.
      if (!(error instanceof DuplicateKeyError)) throw error;
      result = await attempt();
    }
    // Chỉ sau khi đã commit, và chỉ cho lần tạo mới.
    if (!result.replayed) this.deps.submitter.submitSoon(input.tenant, result.body.topupId);
    return result;
  }

  private replay(existing: StoredTopupResponse, requestHash: string): RequestTopupResult {
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyConflictError(
        `Idempotency-Key "${existing.key}" was already used with different content`,
      );
    }
    return {
      status: ACCEPTED,
      body: JSON.parse(existing.responseBody) as TopupCreatedView,
      replayed: true,
    };
  }
}
```

`services/wallet/src/application/get-topup.ts`:
```ts
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { TopupNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toTopupView, type TopupView } from './views.js';

export class GetTopup {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: { tenant: TenantId; customerId: CustomerId; topupId: string }): Promise<TopupView> {
    const topup = await this.deps.uow.run(input.tenant, ({ topups }) => topups.findById(input.topupId));
    // Lần nạp của khách khác bị che giấu bằng cùng một lỗi với id không tồn tại.
    if (!topup || topup.toProps().customerId !== input.customerId.value) {
      throw new TopupNotFoundError('topup not found');
    }
    return toTopupView(topup);
  }
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm test:integration request-topup get-topup && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check`
Expected: PASS, gồm ca 5 request đồng thời cùng key (đúng 1 lần nạp, đúng 1 lần `submitSoon`).

- [ ] **Step 5: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): add RequestTopup with idempotency and GetTopup"
```

---

### Task 9: Cổng payment, `SubmitTopup` và `SubmitDueTopups`

**Files:**
- Modify: `services/wallet/src/application/ports.ts` (thêm `PaymentGateway`), `packages/testing/src/index.ts`
- Create: `packages/testing/src/fake-payment-server.ts`, `services/wallet/src/infrastructure/http-payment-gateway.ts`, `application/submit-topup.ts`, `application/submit-due-topups.ts`
- Test: `packages/testing/src/fake-payment-server.test.ts`, `services/wallet/src/infrastructure/http-payment-gateway.test.ts`, `application/submit-topup.integration.test.ts`, `application/submit-due-topups.integration.test.ts`

**Interfaces:**
- Consumes: `Topup` (Task 4), `TenantUnitOfWork`, `Clock` (Task 6), `Money` từ `@billing/money`.
- Produces:
  - (testing) `class FakePaymentServer { static start(): Promise<FakePaymentServer>; readonly baseUrl: string; readonly requests: FakePaymentRequest[]; enqueue(...responses: FakePaymentResponse[]): this; setFallback(fn: (requestNumber: number) => FakePaymentResponse): this; close(): Promise<void> }`, `interface FakePaymentRequest { method: string; url: string; headers: IncomingHttpHeaders; body: string }`, `interface FakePaymentResponse { status: number; body?: unknown; delayMs?: number }`; phản hồi mặc định (khi hàng đợi rỗng): `202 { chargeId: "ch_fake_<n>", status: "PENDING" }` với `n` là số thứ tự request
  - (application) `interface GatewayChargeRequest { idempotencyKey: string; amount: Money; reference: string; metadata: Record<string, string> }`; `type GatewayChargeResult = { kind: 'created'; chargeId: string } | { kind: 'rejected'; status: number; message: string } | { kind: 'unavailable'; error: string }`; `interface PaymentGateway { createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult> }` — **không bao giờ ném**
  - (infrastructure) `class HttpPaymentGateway implements PaymentGateway` (`constructor(options: { baseUrl: string; timeoutMs: number; fetchImpl?: typeof fetch })`): `POST <baseUrl>/charges` với header `content-type: application/json`, `idempotency-key`, body `{ amount, currency, reference, metadata }`; `202` có `chargeId` là chuỗi không rỗng → `created`; mã `4xx` khác `408`/`429` → `rejected` (kèm `status` và `message` lấy từ `error.message` của body nếu có); `408`, `429`, `5xx`, lỗi mạng, timeout, hoặc `202` thiếu `chargeId` → `unavailable`
  - (application) `type SubmitOutcome = 'SUBMITTED' | 'REJECTED' | 'RETRY_SCHEDULED' | 'FAILED' | 'SUPERSEDED' | 'NOT_DUE'`; `SubmitTopup({ uow, gateway, clock, backoffSeconds, leaseSeconds? }).executeFor(tenant: TenantId, topupId: string): Promise<SubmitOutcome>` và `.executeNextDue(tenant: TenantId): Promise<SubmitOutcome | null>` (`null` khi không còn gì đến hạn). Quy trình: (a) transaction ngắn: khóa lần nạp, kiểm `isDue`, `claim` với lease (mặc định 60 s); (b) gọi `gateway.createCharge({ idempotencyKey: 'topup:<tenant>:<topupId>', amount, reference: topupId, metadata: { tenantId } })` **ngoài transaction**; (c) transaction mới: khóa lại lần nạp — nếu không còn `REQUESTED` (webhook đã chốt trước) thì trả `SUPERSEDED` và không đụng gì; ngược lại `created` → `recordSubmitted` (`SUBMITTED`), `rejected` → `recordRejected` (`REJECTED`), `unavailable` → `recordUnavailable` với `backoffSeconds` (`RETRY_SCHEDULED`, hoặc `FAILED` khi hết lượt)
  - (application) `SubmitDueTopups({ submit }).execute(tenant: TenantId, limit?: number, options?: { shouldContinue?: () => boolean }): Promise<SubmitReport>` với `SubmitReport = { submitted: number; rejected: number; retrying: number; failed: number; superseded: number }`; lặp tối đa `limit` (mặc định 50) lần `executeNextDue`, kiểm `shouldContinue` **trước** mỗi lần chiếm; dừng khi hết việc

- [ ] **Step 1: Viết test thất bại cho `FakePaymentServer` và `HttpPaymentGateway` (unit, không Docker)**

`packages/testing/src/fake-payment-server.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentServer } from './fake-payment-server.js';

let server: FakePaymentServer;
beforeEach(async () => {
  server = await FakePaymentServer.start();
});
afterEach(async () => {
  await server.close();
});

const post = (body: object) =>
  fetch(`${server.baseUrl}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
    body: JSON.stringify(body),
  });

describe('FakePaymentServer', () => {
  it('records requests and answers 202 with a numbered charge id by default', async () => {
    const first = await post({ a: 1 });
    const second = await post({ a: 2 });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ chargeId: 'ch_fake_1', status: 'PENDING' });
    expect(await second.json()).toEqual({ chargeId: 'ch_fake_2', status: 'PENDING' });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]).toMatchObject({ method: 'POST', url: '/charges', body: '{"a":1}' });
    expect(server.requests[0]?.headers['idempotency-key']).toBe('k1');
  });

  it('plays queued responses first, then falls back', async () => {
    server.enqueue({ status: 500 }, { status: 422, body: { error: { code: 'X', message: 'nope' } } });
    expect((await post({})).status).toBe(500);
    const second = await post({});
    expect(second.status).toBe(422);
    expect(await second.json()).toEqual({ error: { code: 'X', message: 'nope' } });
    expect((await post({})).status).toBe(202);
  });

  it('supports a custom fallback and delayed answers', async () => {
    server.setFallback((n) => ({ status: 202, body: { chargeId: `custom_${n}` }, delayMs: 60 }));
    const started = Date.now();
    const res = await post({});
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(await res.json()).toEqual({ chargeId: 'custom_1' });
  });
});
```

`services/wallet/src/infrastructure/http-payment-gateway.test.ts`:
```ts
import { Money } from '@billing/money';
import { FakePaymentServer } from '@billing/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GatewayChargeRequest } from '../application/ports.js';
import { HttpPaymentGateway } from './http-payment-gateway.js';

let server: FakePaymentServer;
beforeEach(async () => {
  server = await FakePaymentServer.start();
});
afterEach(async () => {
  await server.close();
});

const request: GatewayChargeRequest = {
  idempotencyKey: 'topup:acme:tp_1',
  amount: Money.of(150000, 'VND'),
  reference: 'tp_1',
  metadata: { tenantId: 'acme' },
};
const gateway = (overrides: { timeoutMs?: number; baseUrl?: string } = {}) =>
  new HttpPaymentGateway({ baseUrl: server.baseUrl, timeoutMs: 1000, ...overrides });

describe('HttpPaymentGateway', () => {
  it('posts the charge with its idempotency key and metadata, and returns the charge id', async () => {
    expect(await gateway().createCharge(request)).toEqual({ kind: 'created', chargeId: 'ch_fake_1' });
    const [sent] = server.requests;
    expect(sent).toMatchObject({ method: 'POST', url: '/charges' });
    expect(sent?.headers['idempotency-key']).toBe('topup:acme:tp_1');
    expect(sent?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      amount: 150000,
      currency: 'VND',
      reference: 'tp_1',
      metadata: { tenantId: 'acme' },
    });
  });

  it.each([400, 404, 422])('treats %d as a rejection and surfaces the gateway message', async (status) => {
    server.enqueue({ status, body: { error: { code: 'INVALID_REQUEST', message: 'bad amount' } } });
    expect(await gateway().createCharge(request)).toEqual({ kind: 'rejected', status, message: 'bad amount' });
  });

  it('falls back to a generic message when the rejection has no readable body', async () => {
    server.enqueue({ status: 400 });
    expect(await gateway().createCharge(request)).toEqual({ kind: 'rejected', status: 400, message: 'HTTP 400' });
  });

  it.each([408, 429, 500, 502, 503])('treats %d as temporarily unavailable', async (status) => {
    server.enqueue({ status });
    expect(await gateway().createCharge(request)).toEqual({ kind: 'unavailable', error: `HTTP ${status}` });
  });

  it('treats a 202 without a charge id as unavailable', async () => {
    server.enqueue({ status: 202, body: { status: 'PENDING' } }, { status: 202, body: { chargeId: '' } });
    expect((await gateway().createCharge(request)).kind).toBe('unavailable');
    expect((await gateway().createCharge(request)).kind).toBe('unavailable');
  });

  it('treats a connection error as unavailable and never throws', async () => {
    const baseUrl = server.baseUrl;
    await server.close();
    const result = await gateway({ baseUrl }).createCharge(request);
    expect(result.kind).toBe('unavailable');
  });

  it('gives up on a gateway that is too slow', async () => {
    server.enqueue({ status: 202, body: { chargeId: 'ch_slow' }, delayMs: 500 });
    const result = await gateway({ timeoutMs: 50 }).createCharge(request);
    expect(result.kind).toBe('unavailable');
    expect(result.kind === 'unavailable' && result.error).toMatch(/abort|timeout/i);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/testing/src/fake-payment-server.test.ts services/wallet/src/infrastructure/http-payment-gateway.test.ts`
Expected: FAIL (không resolve được module).

- [ ] **Step 3: Cài `FakePaymentServer`, port và `HttpPaymentGateway`**

`packages/testing/src/fake-payment-server.ts`:
```ts
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakePaymentRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakePaymentResponse {
  status: number;
  body?: unknown;
  delayMs?: number;
}

const defaultResponse = (requestNumber: number): FakePaymentResponse => ({
  status: 202,
  body: { chargeId: `ch_fake_${requestNumber}`, status: 'PENDING' },
});

/** Máy chủ HTTP giả đóng vai payment: ghi lại request và trả phản hồi theo kịch bản. */
export class FakePaymentServer {
  readonly requests: FakePaymentRequest[] = [];
  readonly baseUrl: string;
  #queue: FakePaymentResponse[] = [];
  #fallback: (requestNumber: number) => FakePaymentResponse = defaultResponse;
  #server: Server;

  private constructor(server: Server, baseUrl: string) {
    this.#server = server;
    this.baseUrl = baseUrl;
  }

  static async start(): Promise<FakePaymentServer> {
    let fake: FakePaymentServer | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        fake?.requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const response = fake?.nextResponse() ?? defaultResponse(0);
        setTimeout(() => {
          res.writeHead(response.status, { 'content-type': 'application/json' });
          res.end(response.body === undefined ? '' : JSON.stringify(response.body));
        }, response.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // eslint-disable-next-line prefer-const -- gán sau khi server đã lắng nghe vì handler cần tham chiếu đến `fake`
    fake = new FakePaymentServer(server, `http://127.0.0.1:${port}`);
    return fake;
  }

  enqueue(...responses: FakePaymentResponse[]): this {
    this.#queue.push(...responses);
    return this;
  }

  setFallback(fallback: (requestNumber: number) => FakePaymentResponse): this {
    this.#fallback = fallback;
    return this;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  private nextResponse(): FakePaymentResponse {
    return this.#queue.shift() ?? this.#fallback(this.requests.length);
  }
}
```

Thêm vào `packages/testing/src/index.ts` (cùng nhóm export hiện có):
```ts
export { FakePaymentServer } from './fake-payment-server.js';
export type { FakePaymentRequest, FakePaymentResponse } from './fake-payment-server.js';
```

Thêm vào **cuối** `services/wallet/src/application/ports.ts` (kèm `import type { Money } from '@billing/money';` ở đầu file, cùng nhóm import):
```ts

export interface GatewayChargeRequest {
  idempotencyKey: string;
  amount: Money;
  reference: string;
  metadata: Record<string, string>;
}

export type GatewayChargeResult =
  | { kind: 'created'; chargeId: string }
  | { kind: 'rejected'; status: number; message: string }
  | { kind: 'unavailable'; error: string };

export interface PaymentGateway {
  /** Không bao giờ ném: mọi lỗi được trả về dưới dạng `rejected` (đừng thử lại) hoặc `unavailable` (thử lại sau). */
  createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult>;
}
```

`services/wallet/src/infrastructure/http-payment-gateway.ts`:
```ts
import type {
  GatewayChargeRequest,
  GatewayChargeResult,
  PaymentGateway,
} from '../application/ports.js';

export interface HttpPaymentGatewayOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Các mã 4xx mà việc thử lại có thể có ích. */
const RETRYABLE_CLIENT_ERRORS = new Set([408, 429]);

export class HttpPaymentGateway implements PaymentGateway {
  constructor(private readonly options: HttpPaymentGatewayOptions) {}

  async createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult> {
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(`${this.options.baseUrl}/charges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify({
          amount: request.amount.amount,
          currency: request.amount.currency,
          reference: request.reference,
          metadata: request.metadata,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const text = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = text === '' ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }

      if (response.status === 202) {
        const chargeId = (parsed as { chargeId?: unknown } | undefined)?.chargeId;
        if (typeof chargeId === 'string' && chargeId !== '') return { kind: 'created', chargeId };
        return { kind: 'unavailable', error: 'malformed response from payment (missing chargeId)' };
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        !RETRYABLE_CLIENT_ERRORS.has(response.status)
      ) {
        const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
        return {
          kind: 'rejected',
          status: response.status,
          message: typeof message === 'string' ? message : `HTTP ${response.status}`,
        };
      }
      return { kind: 'unavailable', error: `HTTP ${response.status}` };
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
```

- [ ] **Step 4: Chạy lại test unit**

Run: `corepack pnpm exec vitest run packages/testing services/wallet/src/infrastructure/http-payment-gateway.test.ts`
Expected: PASS.

- [ ] **Step 5: Viết test thất bại cho `SubmitTopup` và `SubmitDueTopups`**

`services/wallet/src/application/submit-topup.integration.test.ts`:
```ts
import type { Money } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import type { GatewayChargeRequest, GatewayChargeResult, PaymentGateway } from './ports.js';
import { RequestTopup } from './request-topup.js';
import { SubmitTopup } from './submit-topup.js';

class ScriptedGateway implements PaymentGateway {
  readonly requests: GatewayChargeRequest[] = [];
  #script: GatewayChargeResult[] = [];
  onCall: ((request: GatewayChargeRequest) => Promise<void>) | undefined;

  enqueue(...results: GatewayChargeResult[]): this {
    this.#script.push(...results);
    return this;
  }

  async createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult> {
    this.requests.push(request);
    await this.onCall?.(request);
    return this.#script.shift() ?? { kind: 'created', chargeId: `ch_${this.requests.length}` };
  }
}

let h: Harness;
let gateway: ScriptedGateway;
let submit: SubmitTopup;
let requestTopup: RequestTopup;
let createWallet: CreateWallet;
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  requestTopup = new RequestTopup({ uow: h.uow, clock: h.clock, ids: h.ids, submitter: { submitSoon: () => undefined } });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  gateway = new ScriptedGateway();
  submit = new SubmitTopup({ uow: h.uow, gateway, clock: h.clock, backoffSeconds: [1, 5], leaseSeconds: 60 });
  h.clock.set('2026-10-10T10:00:00.000Z');
});

/** Tạo ví mới rồi một lần nạp REQUESTED cho khách đó; mỗi test dùng khách riêng nên không ảnh hưởng nhau. */
async function seed(tenant: TenantId = h.acme, amount = 150000): Promise<{ tenant: TenantId; topupId: string; customer: string }> {
  const customer = `s${++counter}`;
  await createWallet.execute({ tenant, customerId: CustomerId.parse(customer), currency: 'VND' });
  const { body } = await requestTopup.execute({ tenant, customerId: CustomerId.parse(customer), idempotencyKey: 'k', amount });
  return { tenant, topupId: body.topupId, customer };
}
const row = async (tenant: TenantId, id: string) =>
  (await h.db.withSchema(`t_${tenant.value}`).selectFrom('topups').selectAll().where('id', '=', id).execute())[0];
const plusSeconds = (seconds: number) => new Date(new Date('2026-10-10T10:00:00.000Z').getTime() + seconds * 1000);

describe('SubmitTopup', () => {
  it('sends the charge with the documented idempotency key, reference and tenant metadata, then marks it PENDING', async () => {
    const { tenant, topupId } = await seed();
    expect(await submit.executeFor(tenant, topupId)).toBe('SUBMITTED');
    expect(gateway.requests).toHaveLength(1);
    const sent = gateway.requests[0];
    expect(sent).toMatchObject({
      idempotencyKey: `topup:acme:${topupId}`,
      reference: topupId,
      metadata: { tenantId: 'acme' },
    });
    expect((sent?.amount as Money).amount).toBe(150000);
    expect(await row(tenant, topupId)).toMatchObject({ status: 'PENDING', charge_id: 'ch_1', attempts: 1, next_attempt_at: null });
  });

  it('fails immediately when the gateway rejects the request', async () => {
    const { tenant, topupId } = await seed();
    gateway.enqueue({ kind: 'rejected', status: 422, message: 'bad' });
    expect(await submit.executeFor(tenant, topupId)).toBe('REJECTED');
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PAYMENT_REJECTED',
      attempts: 1,
      next_attempt_at: null,
    });
  });

  it('retries on the backoff schedule and gives up with PAYMENT_UNAVAILABLE when attempts run out', async () => {
    const { tenant, topupId } = await seed();
    gateway.enqueue(...Array.from({ length: 3 }, () => ({ kind: 'unavailable', error: 'down' }) as const));

    expect(await submit.executeFor(tenant, topupId)).toBe('RETRY_SCHEDULED');
    expect(await row(tenant, topupId)).toMatchObject({ status: 'REQUESTED', attempts: 1, next_attempt_at: plusSeconds(1) });

    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    expect(gateway.requests).toHaveLength(1);

    h.clock.advanceSeconds(1);
    expect(await submit.executeFor(tenant, topupId)).toBe('RETRY_SCHEDULED');
    expect(await row(tenant, topupId)).toMatchObject({ attempts: 2, next_attempt_at: plusSeconds(6) });

    h.clock.advanceSeconds(5);
    expect(await submit.executeFor(tenant, topupId)).toBe('FAILED');
    expect(await row(tenant, topupId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'PAYMENT_UNAVAILABLE',
      attempts: 3,
      next_attempt_at: null,
    });
    h.clock.advanceSeconds(10_000);
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    expect(gateway.requests).toHaveLength(3);
  });

  it('uses the same idempotency key on every retry and ends up PENDING once the gateway recovers', async () => {
    const { tenant, topupId } = await seed();
    gateway.enqueue({ kind: 'unavailable', error: 'down' }, { kind: 'created', chargeId: 'ch_ok' });
    await submit.executeFor(tenant, topupId);
    h.clock.advanceSeconds(1);
    expect(await submit.executeFor(tenant, topupId)).toBe('SUBMITTED');
    expect(new Set(gateway.requests.map((r) => r.idempotencyKey)).size).toBe(1);
    expect(await row(tenant, topupId)).toMatchObject({ status: 'PENDING', charge_id: 'ch_ok', attempts: 2 });
  });

  it('does not resend a topup that is leased until the lease expires (crash recovery)', async () => {
    const { tenant, topupId } = await seed();
    await h.uow.run(tenant, async ({ topups }) => {
      const topup = await topups.lockById(topupId);
      if (!topup) throw new Error('missing topup');
      await topups.save(topup.claim(h.clock.now(), 60));
    });
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    h.clock.advanceSeconds(59);
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
    h.clock.advanceSeconds(1);
    expect(await submit.executeFor(tenant, topupId)).toBe('SUBMITTED');
  });

  it('leaves a topup alone when the webhook settled it while the charge request was in flight (SUPERSEDED)', async () => {
    const { tenant, topupId } = await seed();
    gateway.onCall = async () => {
      await h.uow.run(tenant, async ({ topups }) => {
        const topup = await topups.lockById(topupId);
        if (!topup) throw new Error('missing topup');
        await topups.save(topup.applySucceeded('ch_from_webhook', h.clock.now()));
      });
    };
    expect(await submit.executeFor(tenant, topupId)).toBe('SUPERSEDED');
    expect(await row(tenant, topupId)).toMatchObject({ status: 'SUCCEEDED', charge_id: 'ch_from_webhook' });
  });

  it('answers NOT_DUE for an unknown topup and for one that is no longer REQUESTED', async () => {
    const { tenant, topupId } = await seed();
    expect(await submit.executeFor(tenant, 'tp_nope')).toBe('NOT_DUE');
    await submit.executeFor(tenant, topupId);
    expect(await submit.executeFor(tenant, topupId)).toBe('NOT_DUE');
  });

  it('executeNextDue() takes the oldest due topup, returns null when nothing is due, and ignores other tenants', async () => {
    const older = await seed(h.acme);
    h.clock.advanceSeconds(5);
    await seed(h.acme);
    expect(await submit.executeNextDue(h.acme)).toBe('SUBMITTED');
    expect(gateway.requests[0]?.reference).toBe(older.topupId);

    const betaOnly = await seed(h.beta);
    expect(await submit.executeNextDue(h.acme)).toBe('SUBMITTED');
    expect(await submit.executeNextDue(h.acme)).toBeNull();
    expect((await row(betaOnly.tenant, betaOnly.topupId))?.status).toBe('REQUESTED');
  });

  it('never submits the same topup twice when two workers run at once', async () => {
    await seed();
    await seed();
    const outcomes = await Promise.all([submit.executeNextDue(h.acme), submit.executeNextDue(h.acme)]);
    expect(outcomes).toEqual(['SUBMITTED', 'SUBMITTED']);
    expect(new Set(gateway.requests.map((r) => r.reference)).size).toBe(2);
  });
});
```
Lưu ý: ca "oldest due" và ca hai worker chạy trong cùng database nên các topup `REQUESTED` còn sót của ca khác có thể bị `executeNextDue` nhặt. Mỗi test trong file này phải dọn trước: thêm vào `beforeEach` một lệnh đặt mọi topup `REQUESTED` còn lại về trạng thái không đến hạn cho cả hai tenant:
```ts
beforeEach(async () => {
  for (const schema of ['t_acme', 't_beta']) {
    await h.db.withSchema(schema).updateTable('topups').set({ status: 'FAILED', failure_code: 'TEST_CLEANUP', next_attempt_at: null }).where('status', '=', 'REQUESTED').execute();
  }
});
```
(đặt **trước** `gateway = new ScriptedGateway()` trong cùng `beforeEach`, biến `beforeEach` đó thành `async`). Việc này không đụng vào sổ cái (bảng `topups` không có trigger).

`services/wallet/src/application/submit-due-topups.integration.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import { CreateWallet } from './create-wallet.js';
import type { GatewayChargeRequest, GatewayChargeResult, PaymentGateway } from './ports.js';
import { RequestTopup } from './request-topup.js';
import { SubmitDueTopups } from './submit-due-topups.js';
import { SubmitTopup } from './submit-topup.js';

let h: Harness;
let requestTopup: RequestTopup;
let createWallet: CreateWallet;
let counter = 0;
const sent: string[] = [];
let outcome: (request: GatewayChargeRequest) => GatewayChargeResult = (request) => ({
  kind: 'created',
  chargeId: `ch_${request.reference}`,
});
const gateway: PaymentGateway = {
  async createCharge(request) {
    sent.push(request.reference);
    return outcome(request);
  },
};

let submitDue: SubmitDueTopups;

beforeAll(async () => {
  h = await createHarness();
  createWallet = new CreateWallet({ uow: h.uow, clock: h.clock });
  requestTopup = new RequestTopup({ uow: h.uow, clock: h.clock, ids: h.ids, submitter: { submitSoon: () => undefined } });
  submitDue = new SubmitDueTopups({
    submit: new SubmitTopup({ uow: h.uow, gateway, clock: h.clock, backoffSeconds: [1], leaseSeconds: 60 }),
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  sent.length = 0;
  outcome = (request) => ({ kind: 'created', chargeId: `ch_${request.reference}` });
  h.clock.set('2026-10-10T10:00:00.000Z');
  for (const schema of ['t_acme', 't_beta']) {
    await h.db
      .withSchema(schema)
      .updateTable('topups')
      .set({ status: 'FAILED', failure_code: 'TEST_CLEANUP', next_attempt_at: null })
      .where('status', '=', 'REQUESTED')
      .execute();
  }
});

async function seed(tenant: TenantId): Promise<string> {
  const customer = `d${++counter}`;
  await createWallet.execute({ tenant, customerId: CustomerId.parse(customer), currency: 'VND' });
  const { body } = await requestTopup.execute({ tenant, customerId: CustomerId.parse(customer), idempotencyKey: 'k', amount: 100 });
  h.clock.advanceSeconds(1);
  return body.topupId;
}
const status = async (tenant: TenantId, id: string) =>
  (await h.db.withSchema(`t_${tenant.value}`).selectFrom('topups').select(['status', 'next_attempt_at']).where('id', '=', id).execute())[0];

describe('SubmitDueTopups', () => {
  it('submits every due topup of the tenant, oldest first, and reports the outcomes', async () => {
    const ids = [await seed(h.acme), await seed(h.acme), await seed(h.acme)];
    h.clock.advanceSeconds(10);
    expect(await submitDue.execute(h.acme)).toEqual({ submitted: 3, rejected: 0, retrying: 0, failed: 0, superseded: 0 });
    expect(sent).toEqual(ids);
  });

  it('honours the limit', async () => {
    for (let i = 0; i < 3; i++) await seed(h.acme);
    h.clock.advanceSeconds(10);
    expect((await submitDue.execute(h.acme, 2)).submitted).toBe(2);
    expect((await submitDue.execute(h.acme, 2)).submitted).toBe(1);
  });

  it('counts rejected, retrying and failed outcomes separately', async () => {
    await seed(h.acme);
    await seed(h.acme);
    await seed(h.acme);
    h.clock.advanceSeconds(10);
    const script: GatewayChargeResult[] = [
      { kind: 'rejected', status: 422, message: 'bad' },
      { kind: 'unavailable', error: 'down' },
      { kind: 'created', chargeId: 'ch_x' },
    ];
    outcome = () => script.shift() ?? { kind: 'created', chargeId: 'ch_y' };
    expect(await submitDue.execute(h.acme)).toEqual({ submitted: 1, rejected: 1, retrying: 1, failed: 0, superseded: 0 });
  });

  it('stops claiming new topups once shouldContinue turns false, leaving the rest untouched and unleased', async () => {
    const ids = [await seed(h.acme), await seed(h.acme), await seed(h.acme)];
    h.clock.advanceSeconds(10);
    let sends = 0;
    outcome = () => {
      sends += 1;
      return { kind: 'created', chargeId: 'ch_z' };
    };
    const report = await submitDue.execute(h.acme, 50, { shouldContinue: () => sends < 1 });
    expect(report).toEqual({ submitted: 1, rejected: 0, retrying: 0, failed: 0, superseded: 0 });
    expect((await status(h.acme, ids[0] ?? ''))?.status).toBe('PENDING');
    for (const id of ids.slice(1)) {
      const row = await status(h.acme, id);
      expect(row?.status).toBe('REQUESTED');
      expect(row?.next_attempt_at).not.toBeNull();
      expect((row?.next_attempt_at as Date).getTime()).toBeLessThanOrEqual(h.clock.now().getTime());
    }
  });

  it('only touches the given tenant', async () => {
    const inBeta = await seed(h.beta);
    await seed(h.acme);
    h.clock.advanceSeconds(10);
    await submitDue.execute(h.acme);
    expect((await status(h.beta, inBeta))?.status).toBe('REQUESTED');
  });

  it('does nothing when nothing is due', async () => {
    expect(await submitDue.execute(h.acme)).toEqual({ submitted: 0, rejected: 0, retrying: 0, failed: 0, superseded: 0 });
    expect(sent).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration submit-topup submit-due-topups`
Expected: FAIL (không resolve được `./submit-topup.js`, `./submit-due-topups.js`).

- [ ] **Step 7: Cài `SubmitTopup` và `SubmitDueTopups`**

`services/wallet/src/application/submit-topup.ts`:
```ts
import type { TenantId } from '../domain/tenant-id.js';
import type { Topup } from '../domain/topup.js';
import type { Clock, PaymentGateway, TenantUnitOfWork } from './ports.js';

export type SubmitOutcome =
  | 'SUBMITTED'
  | 'REJECTED'
  | 'RETRY_SCHEDULED'
  | 'FAILED'
  | 'SUPERSEDED'
  | 'NOT_DUE';

const DEFAULT_LEASE_SECONDS = 60;

/**
 * Gửi một lần nạp sang payment. Đường code duy nhất cho cả lần thử ngay sau `POST /topups` lẫn worker:
 * (a) chiếm lần nạp bằng lease trong transaction ngắn, (b) gọi payment NGOÀI transaction (idempotency key
 * cố định nên gọi lại luôn an toàn), (c) ghi kết quả trong transaction mới — trừ khi webhook đã chốt trước.
 */
export class SubmitTopup {
  private readonly leaseSeconds: number;

  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      gateway: PaymentGateway;
      clock: Clock;
      backoffSeconds: readonly number[];
      leaseSeconds?: number;
    },
  ) {
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  async executeFor(tenant: TenantId, topupId: string): Promise<SubmitOutcome> {
    const claimed = await this.deps.uow.run(tenant, async ({ topups }) => {
      const topup = await topups.lockById(topupId);
      if (!topup) return null;
      const now = this.deps.clock.now();
      if (!topup.isDue(now)) return null;
      await topups.save(topup.claim(now, this.leaseSeconds));
      return topup;
    });
    return claimed ? this.submitClaimed(tenant, claimed) : 'NOT_DUE';
  }

  /** Lần nạp đến hạn cũ nhất của tenant; `null` khi không còn gì đến hạn. */
  async executeNextDue(tenant: TenantId): Promise<SubmitOutcome | null> {
    const claimed = await this.deps.uow.run(tenant, async ({ topups }) => {
      const now = this.deps.clock.now();
      const topup = await topups.lockNextDue(now);
      if (!topup) return null;
      await topups.save(topup.claim(now, this.leaseSeconds));
      return topup;
    });
    return claimed ? this.submitClaimed(tenant, claimed) : null;
  }

  private async submitClaimed(tenant: TenantId, claimed: Topup): Promise<SubmitOutcome> {
    const props = claimed.toProps();
    const result = await this.deps.gateway.createCharge({
      idempotencyKey: `topup:${tenant.value}:${props.id}`,
      amount: props.amount,
      reference: props.id,
      metadata: { tenantId: tenant.value },
    });

    return this.deps.uow.run(tenant, async ({ topups }): Promise<SubmitOutcome> => {
      const current = await topups.lockById(props.id);
      // Webhook có thể đã chốt lần nạp trong lúc ta chờ payment: không ghi đè.
      if (!current || current.toProps().status !== 'REQUESTED') return 'SUPERSEDED';
      const now = this.deps.clock.now();
      switch (result.kind) {
        case 'created':
          await topups.save(current.recordSubmitted(result.chargeId));
          return 'SUBMITTED';
        case 'rejected':
          await topups.save(current.recordRejected(now));
          return 'REJECTED';
        case 'unavailable': {
          const next = current.recordUnavailable(now, this.deps.backoffSeconds);
          await topups.save(next);
          return next.toProps().status === 'FAILED' ? 'FAILED' : 'RETRY_SCHEDULED';
        }
      }
    });
  }
}
```

`services/wallet/src/application/submit-due-topups.ts`:
```ts
import type { TenantId } from '../domain/tenant-id.js';
import type { SubmitTopup } from './submit-topup.js';

const DEFAULT_BATCH = 50;

export interface SubmitReport {
  submitted: number;
  rejected: number;
  retrying: number;
  failed: number;
  superseded: number;
}

export class SubmitDueTopups {
  constructor(private readonly deps: { submit: Pick<SubmitTopup, 'executeNextDue'> }) {}

  /**
   * Mỗi vòng chiếm MỘT lần nạp ngay trước khi gửi (lease chỉ cần phủ một lần gọi), và kiểm tra
   * `shouldContinue` trước khi chiếm để dừng êm giữa các lần nạp khi worker bị dừng.
   */
  async execute(
    tenant: TenantId,
    limit = DEFAULT_BATCH,
    options: { shouldContinue?: () => boolean } = {},
  ): Promise<SubmitReport> {
    const report: SubmitReport = { submitted: 0, rejected: 0, retrying: 0, failed: 0, superseded: 0 };
    for (let i = 0; i < limit; i++) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      const outcome = await this.deps.submit.executeNextDue(tenant);
      if (outcome === null) break;
      if (outcome === 'SUBMITTED') report.submitted += 1;
      else if (outcome === 'REJECTED') report.rejected += 1;
      else if (outcome === 'RETRY_SCHEDULED') report.retrying += 1;
      else if (outcome === 'FAILED') report.failed += 1;
      else if (outcome === 'SUPERSEDED') report.superseded += 1;
    }
    return report;
  }
}
```

- [ ] **Step 8: Chạy test, lint, typecheck**

```bash
corepack pnpm test:integration submit-topup submit-due-topups
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test
```
Expected: PASS. Nếu `switch` trong `submitClaimed` bị TypeScript báo "not all code paths return a value", thêm nhánh `default` không thể đạt tới ném lỗi (`const exhaustive: never = result; throw new Error(...)`), không dùng `as`.

- [ ] **Step 9: Commit**

```bash
git add -A packages/testing services/wallet
git commit -m "feat(wallet): add payment gateway client, SubmitTopup (lease, backoff) and SubmitDueTopups"
```

### Task 10: `ApplyPaymentResult` (xử lý kết quả từ payment, ghi sổ)

**Files:**
- Modify: `services/wallet/src/test-support.ts` (thêm `seedTopup`, `SeededTopup`)
- Create: `services/wallet/src/application/apply-payment-result.ts`
- Test: `services/wallet/src/application/apply-payment-result.integration.test.ts`

**Interfaces:**
- Consumes: `TenantUnitOfWork`, `Clock`, `IdGenerator`, `Logger`, `Repositories` (Task 6); `Account.systemId`, `LedgerTransaction.topup`, `Topup` (Task 4); `DuplicateKeyError` (Task 3); `StateTransitionError` (domain).
- Produces:
  - `type PaymentEventType = 'charge.succeeded' | 'charge.failed'`
  - `interface ApplyPaymentResultInput { tenant: TenantId; eventId: string; type: PaymentEventType; chargeId: string; reference: string; amount: number; currency: string; failureCode?: string | undefined }` (`reference` là `topupId`)
  - `type ApplyOutcome = 'APPLIED' | 'DUPLICATE' | 'UNKNOWN_TOPUP' | 'MISMATCH' | 'IGNORED'`
  - `ApplyPaymentResult({ uow, clock, ids, log }).execute(input): Promise<ApplyOutcome>` — **một transaction** theo thứ tự: (1) ghi inbox `("payment-webhook", eventId)`; (2) khóa lần nạp theo `reference`; (3) kiểm tra số tiền, đồng tiền và `chargeId` (nếu lần nạp đã có `chargeId`); (4) `charge.succeeded` → khóa ví + `GATEWAY` theo thứ tự id tăng dần, cộng/trừ, ghi giao dịch `topup:<id>`, đặt `SUCCEEDED`; `charge.failed` → đặt `FAILED` với `failureCode`. Kết quả: trùng `eventId` hoặc trùng `business_key` (`DuplicateKeyError`, giao dịch rollback) → `DUPLICATE`; không có lần nạp → `UNKNOWN_TOPUP`; lệch số tiền/đồng tiền/`chargeId` → `MISMATCH` (không đụng sổ, inbox vẫn được ghi để payment không gửi lại vô ích); trạng thái không cho phép chuyển (đã `SUCCEEDED`, `charge.failed` sau thành công, `FAILED` vì `PAYMENT_REJECTED` rồi mới có `charge.succeeded`…) → `IGNORED`. `UNKNOWN_TOPUP`/`MISMATCH`/`IGNORED` đều được ghi log **sau khi commit** (không có bí mật nào trong log).
  - (test-support) `interface SeededTopup { tenant: TenantId; customer: string; topupId: string; chargeId: string; amount: number; currency: Currency }`; `seedTopup(h: Harness, options?: { tenant?: TenantId; customer?: string; amount?: number; currency?: Currency; state?: 'REQUESTED' | 'PENDING' | 'FAILED_UNAVAILABLE' | 'FAILED_REJECTED' }): Promise<SeededTopup>` — tạo ví (idempotent) rồi một lần nạp; mặc định `acme`, khách mới, `150000 VND`, trạng thái `PENDING` với `chargeId = ch_<topupId>`; `FAILED_UNAVAILABLE` là `FAILED(PAYMENT_UNAVAILABLE)` chưa có `chargeId`.

- [ ] **Step 1: Thêm `seedTopup` vào `test-support.ts`**

Thêm import ở đầu file (cùng nhóm với các import hiện có):
```ts
import type { Currency } from '@billing/money';
import { CreateWallet } from './application/create-wallet.js';
import { RequestTopup } from './application/request-topup.js';
import { CustomerId } from './domain/customer-id.js';
```
Thêm vào **cuối** file:
```ts

export interface SeededTopup {
  tenant: TenantId;
  customer: string;
  topupId: string;
  chargeId: string;
  amount: number;
  currency: Currency;
}

let seedCounter = 0;

/** Dựng nhanh một ví và một lần nạp ở trạng thái mong muốn, bằng chính các use case và aggregate thật. */
export async function seedTopup(
  h: Harness,
  options: {
    tenant?: TenantId;
    customer?: string;
    amount?: number;
    currency?: Currency;
    state?: 'REQUESTED' | 'PENDING' | 'FAILED_UNAVAILABLE' | 'FAILED_REJECTED';
  } = {},
): Promise<SeededTopup> {
  const tenant = options.tenant ?? h.acme;
  const currency = options.currency ?? 'VND';
  const amount = options.amount ?? 150000;
  const customer = options.customer ?? `seed${++seedCounter}`;
  const customerId = CustomerId.parse(customer);
  await new CreateWallet({ uow: h.uow, clock: h.clock }).execute({ tenant, customerId, currency });
  const { body } = await new RequestTopup({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    submitter: { submitSoon: () => undefined },
  }).execute({ tenant, customerId, idempotencyKey: `seed-key-${++seedCounter}`, amount });

  const chargeId = `ch_${body.topupId}`;
  const state = options.state ?? 'PENDING';
  if (state !== 'REQUESTED') {
    await h.uow.run(tenant, async ({ topups }) => {
      const topup = await topups.lockById(body.topupId);
      if (!topup) throw new Error('seeded topup disappeared');
      const now = h.clock.now();
      const next =
        state === 'PENDING'
          ? topup.recordSubmitted(chargeId)
          : state === 'FAILED_REJECTED'
            ? topup.recordRejected(now)
            : topup.recordUnavailable(now, []);
      await topups.save(next);
    });
  }
  return { tenant, customer, topupId: body.topupId, chargeId, amount, currency };
}
```

- [ ] **Step 2: Viết test thất bại**

`services/wallet/src/application/apply-payment-result.integration.test.ts`:
```ts
import type { Currency } from '@billing/money';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import {
  createHarness,
  expectLedgerInvariants,
  seedTopup,
  type Harness,
  type SeededTopup,
} from '../test-support.js';
import { ApplyPaymentResult, type ApplyPaymentResultInput } from './apply-payment-result.js';
import type { Logger } from './ports.js';

interface LogLine {
  level: 'info' | 'warn' | 'error';
  details: object;
  message: string | undefined;
}

let h: Harness;
let apply: ApplyPaymentResult;
let logs: LogLine[];
let eventCounter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  logs = [];
  const log: Logger = {
    info: (details, message) => logs.push({ level: 'info', details, message }),
    warn: (details, message) => logs.push({ level: 'warn', details, message }),
    error: (details, message) => logs.push({ level: 'error', details, message }),
  };
  apply = new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const event = (
  seeded: SeededTopup,
  overrides: Partial<ApplyPaymentResultInput> = {},
): ApplyPaymentResultInput => ({
  tenant: seeded.tenant,
  eventId: `evt_${++eventCounter}`,
  type: 'charge.succeeded',
  chargeId: seeded.chargeId,
  reference: seeded.topupId,
  amount: seeded.amount,
  currency: seeded.currency,
  ...overrides,
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const balance = async (tenant: TenantId, accountId: string): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema(schema(tenant))
        .selectFrom('accounts')
        .select('balance')
        .where('id', '=', accountId)
        .executeTakeFirstOrThrow()
    ).balance,
  );
const topupRow = async (tenant: TenantId, id: string) =>
  h.db.withSchema(schema(tenant)).selectFrom('topups').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const ledgerFor = async (tenant: TenantId, topupId: string) => {
  const transactions = await h.db
    .withSchema(schema(tenant))
    .selectFrom('ledger_transactions')
    .selectAll()
    .where('business_key', '=', `topup:${topupId}`)
    .execute();
  const entries = await h.db
    .withSchema(schema(tenant))
    .selectFrom('ledger_entries')
    .selectAll()
    .where(
      'transaction_id',
      'in',
      transactions.length > 0 ? transactions.map((t) => t.id) : ['none'],
    )
    .execute();
  return { transactions, entries };
};
const gateway = (currency: Currency) => `system:GATEWAY:${currency}`;

describe('ApplyPaymentResult — success', () => {
  it('credits the wallet, debits the gateway, completes the topup and records the event', async () => {
    const seeded = await seedTopup(h);
    const gatewayBefore = await balance(h.acme, gateway('VND'));
    h.clock.advanceSeconds(10);

    expect(await apply.execute(event(seeded))).toBe('APPLIED');

    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'SUCCEEDED',
      charge_id: seeded.chargeId,
      failure_code: null,
      next_attempt_at: null,
      completed_at: new Date('2026-10-10T10:00:10.000Z'),
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect(await balance(h.acme, gateway('VND'))).toBe(gatewayBefore - 150000);
    const { transactions, entries } = await ledgerFor(h.acme, seeded.topupId);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ kind: 'TOPUP', business_key: `topup:${seeded.topupId}` });
    expect(entries.map((e) => [e.account_id, Number(e.amount)]).sort()).toEqual(
      [
        [`wallet:${seeded.customer}`, 150000],
        [gateway('VND'), -150000],
      ].sort(),
    );
    expect(logs.filter((l) => l.level !== 'info')).toEqual([]);
  });

  it('also settles a topup that is still REQUESTED (webhook arrived before the submit result)', async () => {
    const seeded = await seedTopup(h, { state: 'REQUESTED' });
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'SUCCEEDED', charge_id: seeded.chargeId });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });

  it('works for USD with the USD gateway account', async () => {
    const seeded = await seedTopup(h, { currency: 'USD', amount: 25 });
    const before = await balance(h.acme, gateway('USD'));
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(25);
    expect(await balance(h.acme, gateway('USD'))).toBe(before - 25);
  });

  it('credits a topup that already failed with PAYMENT_UNAVAILABLE (the gateway is the source of truth)', async () => {
    const seeded = await seedTopup(h, { state: 'FAILED_UNAVAILABLE' });
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'SUCCEEDED',
      failure_code: null,
      charge_id: seeded.chargeId,
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });

  it('does not credit a topup that failed with PAYMENT_REJECTED and says so in the log', async () => {
    const seeded = await seedTopup(h, { state: 'FAILED_REJECTED' });
    expect(await apply.execute(event(seeded))).toBe('IGNORED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'FAILED', failure_code: 'PAYMENT_REJECTED' });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(0);
    expect(logs.some((l) => l.level !== 'info')).toBe(true);
  });
});

describe('ApplyPaymentResult — failure', () => {
  it('fails a PENDING topup with the gateway failure code and leaves the ledger alone', async () => {
    const seeded = await seedTopup(h);
    h.clock.advanceSeconds(5);
    expect(await apply.execute(event(seeded, { type: 'charge.failed', failureCode: 'card_declined' }))).toBe('APPLIED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'card_declined',
      charge_id: seeded.chargeId,
      completed_at: new Date('2026-10-10T10:00:05.000Z'),
    });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(0);
  });

  it('ignores charge.failed after the topup succeeded, keeps the money, and logs an error', async () => {
    const seeded = await seedTopup(h);
    await apply.execute(event(seeded));
    logs.length = 0;
    expect(await apply.execute(event(seeded, { type: 'charge.failed', failureCode: 'card_declined' }))).toBe('IGNORED');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'SUCCEEDED' });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });
});

describe('ApplyPaymentResult — duplicates', () => {
  it('answers DUPLICATE for the same event id and credits only once', async () => {
    const seeded = await seedTopup(h);
    const first = event(seeded);
    expect(await apply.execute(first)).toBe('APPLIED');
    expect(await apply.execute(first)).toBe('DUPLICATE');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(1);
  });

  it('ignores a second success event (new event id) for a topup that is already SUCCEEDED', async () => {
    const seeded = await seedTopup(h);
    expect(await apply.execute(event(seeded))).toBe('APPLIED');
    expect(await apply.execute(event(seeded))).toBe('IGNORED');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });

  it('applies the same event exactly once when it is delivered concurrently', async () => {
    const seeded = await seedTopup(h);
    const same = event(seeded);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => apply.execute(same)));
    expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(7);
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });

  it('credits once when two different events race for the same topup', async () => {
    const seeded = await seedTopup(h);
    const outcomes = await Promise.all([apply.execute(event(seeded)), apply.execute(event(seeded))]);
    expect([...outcomes].sort()).toEqual(['APPLIED', 'IGNORED']);
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(1);
  });

  it('keeps the balance exact when many topups of one wallet are settled concurrently (no deadlock)', async () => {
    const first = await seedTopup(h, { amount: 1000 });
    const rest = await Promise.all(
      Array.from({ length: 5 }, () => seedTopup(h, { customer: first.customer, amount: 1000 })),
    );
    const outcomes = await Promise.all([first, ...rest].map((s) => apply.execute(event(s))));
    expect(outcomes.every((o) => o === 'APPLIED')).toBe(true);
    expect(await balance(h.acme, `wallet:${first.customer}`)).toBe(6000);
  });
});

describe('ApplyPaymentResult — inconsistent events', () => {
  it('answers UNKNOWN_TOPUP for a reference that does not exist, logs an error and still records the event', async () => {
    const seeded = await seedTopup(h);
    const stray = event(seeded, { reference: 'tp_missing' });
    expect(await apply.execute(stray)).toBe('UNKNOWN_TOPUP');
    expect(logs.some((l) => l.level === 'error')).toBe(true);
    expect(await apply.execute(stray)).toBe('DUPLICATE');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
  });

  it('does not see a topup of another tenant', async () => {
    const seeded = await seedTopup(h, { tenant: h.acme });
    expect(await apply.execute(event(seeded, { tenant: h.beta }))).toBe('UNKNOWN_TOPUP');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'PENDING' });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
  });

  it.each([
    ['a different amount', { amount: 149999 }],
    ['a different currency', { currency: 'USD' }],
    ['a different charge id', { chargeId: 'ch_other' }],
  ])('refuses an event with %s without touching the ledger', async (_name, override) => {
    const seeded = await seedTopup(h);
    expect(await apply.execute(event(seeded, override))).toBe('MISMATCH');
    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'PENDING', completed_at: null });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    expect((await ledgerFor(h.acme, seeded.topupId)).transactions).toHaveLength(0);
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });

  it('rolls everything back, including the inbox record, when something fails after the inbox write', async () => {
    const seeded = await seedTopup(h);
    // Bộ sinh mã hỏng: `transactionId()` chỉ được gọi sau khi inbox đã ghi và tài khoản đã khóa, ngay trước khi ghi sổ.
    const failing = new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: {
        topupId: () => h.ids.topupId(),
        transactionId: () => {
          throw new Error('id generator down');
        },
      },
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const first = event(seeded);
    await expect(failing.execute(first)).rejects.toThrow('id generator down');

    expect(await topupRow(h.acme, seeded.topupId)).toMatchObject({ status: 'PENDING', completed_at: null });
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(0);
    // Nếu inbox không được rollback, lần xử lý lại sẽ bị coi là DUPLICATE và tiền không bao giờ được ghi.
    expect(await apply.execute(first)).toBe('APPLIED');
    expect(await balance(h.acme, `wallet:${seeded.customer}`)).toBe(150000);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration apply-payment-result`
Expected: FAIL (không resolve được `./apply-payment-result.js`).

- [ ] **Step 4: Cài `ApplyPaymentResult`**

`services/wallet/src/application/apply-payment-result.ts`:
```ts
import { Account } from '../domain/account.js';
import { StateTransitionError } from '../domain/errors.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { Topup } from '../domain/topup.js';
import { DuplicateKeyError } from './errors.js';
import type { Clock, IdGenerator, Logger, Repositories, TenantUnitOfWork } from './ports.js';

export type PaymentEventType = 'charge.succeeded' | 'charge.failed';

export interface ApplyPaymentResultInput {
  tenant: TenantId;
  eventId: string;
  type: PaymentEventType;
  chargeId: string;
  /** `topupId` mà wallet đã gửi làm `reference` khi tạo charge. */
  reference: string;
  amount: number;
  currency: string;
  failureCode?: string | undefined;
}

export type ApplyOutcome = 'APPLIED' | 'DUPLICATE' | 'UNKNOWN_TOPUP' | 'MISMATCH' | 'IGNORED';

const CONSUMER = 'payment-webhook';
const UNKNOWN_FAILURE_CODE = 'unknown';

export class ApplyPaymentResult {
  constructor(
    private readonly deps: { uow: TenantUnitOfWork; clock: Clock; ids: IdGenerator; log: Logger },
  ) {}

  async execute(input: ApplyPaymentResultInput): Promise<ApplyOutcome> {
    let outcome: ApplyOutcome;
    try {
      outcome = await this.deps.uow.run(input.tenant, (repositories) => this.apply(repositories, input));
    } catch (error) {
      // Cùng eventId (inbox) hoặc cùng business_key (sổ cái): giao dịch đã rollback, tiền đã được ghi trước đó.
      if (error instanceof DuplicateKeyError) return 'DUPLICATE';
      throw error;
    }
    this.report(outcome, input);
    return outcome;
  }

  private async apply(
    { accounts, ledger, topups, inbox }: Repositories,
    input: ApplyPaymentResultInput,
  ): Promise<ApplyOutcome> {
    const now = this.deps.clock.now();
    await inbox.record(CONSUMER, input.eventId, now);

    const topup = await topups.lockById(input.reference);
    if (!topup) return 'UNKNOWN_TOPUP';

    const props = topup.toProps();
    const consistent =
      props.amount.amount === input.amount &&
      props.amount.currency === input.currency &&
      (props.chargeId === null || props.chargeId === input.chargeId);
    if (!consistent) return 'MISMATCH';

    const next = this.transition(topup, input, now);
    if (next === null) return 'IGNORED';

    if (input.type === 'charge.succeeded') {
      const walletId = props.accountId;
      const gatewayId = Account.systemId('GATEWAY', props.amount.currency);
      const locked = await accounts.lockMany([walletId, gatewayId]);
      const byId = new Map(locked.map((account) => [account.toProps().id, account]));
      const wallet = byId.get(walletId);
      const gateway = byId.get(gatewayId);
      if (!wallet || !gateway) throw new Error(`missing account for topup ${props.id}`);

      await accounts.saveBalance(wallet.apply(props.amount));
      await accounts.saveBalance(gateway.apply(props.amount.negate()));
      await ledger.post(
        LedgerTransaction.topup({
          id: this.deps.ids.transactionId(),
          topupId: props.id,
          walletAccountId: walletId,
          gatewayAccountId: gatewayId,
          amount: props.amount,
          now,
        }),
      );
    }
    await topups.save(next);
    return 'APPLIED';
  }

  /** `null` khi trạng thái hiện tại không cho phép chuyển (đã chốt, hoặc thất bại vì lý do khác). */
  private transition(topup: Topup, input: ApplyPaymentResultInput, now: Date): Topup | null {
    try {
      return input.type === 'charge.succeeded'
        ? topup.applySucceeded(input.chargeId, now)
        : topup.applyFailed(input.failureCode ?? UNKNOWN_FAILURE_CODE, input.chargeId, now);
    } catch (error) {
      if (error instanceof StateTransitionError) return null;
      throw error;
    }
  }

  private report(outcome: ApplyOutcome, input: ApplyPaymentResultInput): void {
    const details = {
      tenantId: input.tenant.value,
      eventId: input.eventId,
      type: input.type,
      reference: input.reference,
      chargeId: input.chargeId,
    };
    switch (outcome) {
      case 'UNKNOWN_TOPUP':
        this.deps.log.error(details, 'payment event references an unknown topup');
        break;
      case 'MISMATCH':
        this.deps.log.error(details, 'payment event does not match the topup; ledger untouched');
        break;
      case 'IGNORED':
        if (input.type === 'charge.failed') {
          this.deps.log.error(details, 'charge.failed ignored: the topup is already settled');
        } else {
          this.deps.log.warn(details, 'charge.succeeded ignored: the topup cannot be completed from its state');
        }
        break;
      case 'APPLIED':
      case 'DUPLICATE':
        break;
    }
  }
}
```

- [ ] **Step 5: Chạy test, lint, typecheck**

```bash
corepack pnpm test:integration apply-payment-result
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS, gồm ca 8 webhook trùng đồng thời (đúng 1 `APPLIED`), 2 sự kiện khác nhau tranh một lần nạp, 6 lần nạp đồng thời cùng một ví (không deadlock, số dư 6000) và bất biến sổ cái sau mỗi test (`afterEach`).

- [ ] **Step 6: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): add ApplyPaymentResult (inbox, ledger posting, late success, mismatch handling)"
```

---

### Task 11: Lớp Nest — guard khách/tenant, ánh xạ lỗi, controller, webhook body thô

**Files:**
- Modify: `services/wallet/package.json` (qua pnpm), `services/wallet/src/app.module.ts` (viết lại)
- Create: `services/wallet/src/interface/http/tokens.ts`, `errors.ts`, `caller.guard.ts`, `wallets.controller.ts`, `topups.controller.ts`, `webhooks.controller.ts`, `create-app.ts`
- Test: `services/wallet/src/interface/http/api.integration.test.ts`

**Interfaces:**
- Consumes: mọi use case của Task 7–10; `TenantRegistry`, `Clock`, `Logger`, `TenantUnitOfWork`; `validateChargeWebhook`, `verifyWebhook`, `signWebhook` từ `@billing/contracts`; `CorrelationMiddleware`, `HealthController` (đã có).
- Produces:
  - `interface AppDeps { registry: TenantRegistry; clock: Clock; log: Logger; webhookSecret: string; createWallet: Pick<CreateWallet, 'execute'>; getWallet: Pick<GetWallet, 'execute'>; listEntries: Pick<ListEntries, 'execute'>; requestTopup: Pick<RequestTopup, 'execute'>; getTopup: Pick<GetTopup, 'execute'>; applyPaymentResult: Pick<ApplyPaymentResult, 'execute'> }` (trong `app.module.ts`)
  - `AppModule.register(deps: AppDeps): DynamicModule`; `createApp(deps: AppDeps): Promise<NestFastifyApplication>` (`create-app.ts`; bật `rawBody`, tắt logger của Nest, gọi `init()` và đợi Fastify `ready()` để `app.inject` dùng được ngay; chưa `listen`)
  - Hành vi HTTP theo mục 3 của spec: mọi lỗi có dạng `{ "error": { "code", "message" } }`; `x-correlation-id` có trên mọi response kể cả lỗi; `500 INTERNAL` với message cố định `internal error`.
  - Ánh xạ lỗi: `MissingTenantError`→`400 MISSING_TENANT`; `UnknownTenantError`→`403 UNKNOWN_TENANT`; `MissingCustomerError`→`400 MISSING_CUSTOMER`; `InvalidCustomerError`, `InvalidMoneyError`, `InvalidTopupError`→`400 INVALID_REQUEST`; `InvalidQueryError`→`400 INVALID_QUERY`; `WalletNotFoundError`→`404 WALLET_NOT_FOUND`; `TopupNotFoundError`→`404 TOPUP_NOT_FOUND`; `WalletCurrencyConflictError`→`409 WALLET_CURRENCY_CONFLICT`; `IdempotencyConflictError`→`422 IDEMPOTENCY_KEY_REUSED`; lỗi có `statusCode` 4xx của Fastify/`HttpException` giữ nguyên mã HTTP (`404 NOT_FOUND`, `400 INVALID_REQUEST`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, còn lại `HTTP_<mã>`); mọi lỗi khác → `500 INTERNAL` (ghi log lỗi gốc).

- [ ] **Step 1: Phụ thuộc**

```bash
corepack pnpm --filter @billing/wallet-service add fastify@^5.12.5
```
Expected: không lỗi (cùng phiên bản với `services/payment`; cần để import kiểu `FastifyReply`/`FastifyRequest` dưới `pnpm` nghiêm ngặt).

- [ ] **Step 2: Viết test thất bại**

`services/wallet/src/interface/http/api.integration.test.ts`:
```ts
import { signWebhook } from '@billing/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { CreateWallet } from '../../application/create-wallet.js';
import { GetTopup } from '../../application/get-topup.js';
import { GetWallet } from '../../application/get-wallet.js';
import { ListEntries } from '../../application/list-entries.js';
import type { Logger, TopupSubmitter } from '../../application/ports.js';
import { RequestTopup } from '../../application/request-topup.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { createHarness, expectLedgerInvariants, seedTopup, type Harness } from '../../test-support.js';
import type { AppDeps } from '../../app.module.js';
import { createApp } from './create-app.js';

const SECRET = 'whsec_test_secret_value';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let h: Harness;
let app: NestFastifyApplication;
let logs: Array<{ level: string; details: object; message: string | undefined }>;
let submitted: Array<{ tenant: string; topupId: string }>;
let counter = 0;

const log = (): Logger => ({
  info: (details, message) => logs.push({ level: 'info', details, message }),
  warn: (details, message) => logs.push({ level: 'warn', details, message }),
  error: (details, message) => logs.push({ level: 'error', details, message }),
});

function buildDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const logger = log();
  const submitter: TopupSubmitter = {
    submitSoon: (tenant: TenantId, topupId: string) => submitted.push({ tenant: tenant.value, topupId }),
  };
  return {
    registry: h.registry,
    clock: h.clock,
    log: logger,
    webhookSecret: SECRET,
    createWallet: new CreateWallet({ uow: h.uow, clock: h.clock }),
    getWallet: new GetWallet({ uow: h.uow }),
    listEntries: new ListEntries({ uow: h.uow }),
    requestTopup: new RequestTopup({ uow: h.uow, clock: h.clock, ids: h.ids, submitter }),
    getTopup: new GetTopup({ uow: h.uow }),
    applyPaymentResult: new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: logger }),
    ...overrides,
  };
}

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  logs = [];
  submitted = [];
  h.clock.set('2026-10-10T10:00:00.000Z');
  app = await createApp(buildDeps());
});
afterEach(async () => {
  await app.close();
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const who = (tenant: string | undefined, customer: string | undefined): Record<string, string> => ({
  ...(tenant === undefined ? {} : { 'x-tenant-id': tenant }),
  ...(customer === undefined ? {} : { 'x-customer-id': customer }),
});
const newCustomer = () => `api${++counter}`;
const errorOf = (body: string): { code: string; message: string } => (JSON.parse(body) as { error: { code: string; message: string } }).error;

async function createWallet(customer: string, currency = 'VND', tenant = 'acme') {
  return app.inject({ method: 'POST', url: '/wallets', headers: who(tenant, customer), payload: { currency } });
}

describe('cross-cutting behaviour', () => {
  it('serves /health without tenant headers and stamps a correlation id on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'wallet' });
    expect(res.headers['x-correlation-id']).toMatch(UUID);
  });

  it('reuses a valid incoming correlation id, also on error responses', async () => {
    const id = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const res = await app.inject({ method: 'GET', url: '/wallet', headers: { 'x-correlation-id': id } });
    expect(res.statusCode).toBe(400);
    expect(res.headers['x-correlation-id']).toBe(id);
  });

  it('answers unknown routes and malformed JSON with the standard error envelope', async () => {
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('NOT_FOUND');

    const bad = await app.inject({
      method: 'POST',
      url: '/wallets',
      headers: { ...who('acme', newCustomer()), 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad.body).code).toBe('INVALID_REQUEST');
  });

  it('turns an unexpected failure into 500 INTERNAL without leaking the cause, and logs it', async () => {
    const broken = await createApp(
      buildDeps({
        getWallet: {
          execute: () => {
            throw new Error('secret detail: connection string xyz');
          },
        },
      }),
    );
    const res = await broken.inject({ method: 'GET', url: '/wallet', headers: who('acme', newCustomer()) });
    await broken.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(res.body).not.toContain('secret detail');
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });
});

describe('tenant and customer headers', () => {
  it.each([
    ['no tenant header', undefined, 'c1', 400, 'MISSING_TENANT'],
    ['a blank tenant header', '  ', 'c1', 400, 'MISSING_TENANT'],
    ['a tenant that is not configured', 'ghost', 'c1', 403, 'UNKNOWN_TENANT'],
    ['a tenant with a bad shape', 'Acme', 'c1', 403, 'UNKNOWN_TENANT'],
    ['a tenant trying to escape the schema', 't_acme]; drop', 'c1', 403, 'UNKNOWN_TENANT'],
    ['no customer header', 'acme', undefined, 400, 'MISSING_CUSTOMER'],
    ['a customer with a bad shape', 'acme', 'a b', 400, 'INVALID_REQUEST'],
    ['a customer that is too long', 'acme', 'x'.repeat(65), 400, 'INVALID_REQUEST'],
  ])('rejects %s', async (_name, tenant, customer, status, code) => {
    const res = await app.inject({ method: 'GET', url: '/wallet', headers: who(tenant, customer) });
    expect(res.statusCode).toBe(status);
    expect(errorOf(res.body).code).toBe(code);
  });

  it('ignores a tenant or customer given in the body or the query', async () => {
    const customer = newCustomer();
    const created = await app.inject({
      method: 'POST',
      url: '/wallets?tenantId=beta&customerId=evil',
      headers: who('acme', customer),
      payload: { currency: 'VND', tenantId: 'beta', customerId: 'evil' },
    });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/wallet', headers: who('acme', customer) })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/wallet', headers: who('beta', customer) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/wallet', headers: who('acme', 'evil') })).statusCode).toBe(404);
  });
});

describe('wallets', () => {
  it('POST /wallets creates (201), repeats (200) and refuses another currency (409)', async () => {
    const customer = newCustomer();
    const first = await createWallet(customer, 'VND');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toEqual({ customerId: customer, currency: 'VND', balance: 0, createdAt: '2026-10-10T10:00:00.000Z' });
    const again = await createWallet(customer, 'VND');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
    const conflict = await createWallet(customer, 'USD');
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict.body).code).toBe('WALLET_CURRENCY_CONFLICT');
  });

  it.each([
    ['an unsupported currency', { currency: 'EUR' }],
    ['a numeric currency', { currency: 5 }],
    ['a missing currency', {}],
    ['an array body', [{ currency: 'VND' }]],
  ])('POST /wallets rejects %s with 400 INVALID_REQUEST', async (_name, payload) => {
    const res = await app.inject({ method: 'POST', url: '/wallets', headers: who('acme', newCustomer()), payload: payload as object });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('INVALID_REQUEST');
  });

  it('POST /wallets without any body is a 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/wallets', headers: who('acme', newCustomer()) });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('INVALID_REQUEST');
  });

  it('GET /wallet answers 404 WALLET_NOT_FOUND, then the wallet', async () => {
    const customer = newCustomer();
    const missing = await app.inject({ method: 'GET', url: '/wallet', headers: who('acme', customer) });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('WALLET_NOT_FOUND');
    await createWallet(customer, 'USD');
    const found = await app.inject({ method: 'GET', url: '/wallet', headers: who('acme', customer) });
    expect(found.json()).toMatchObject({ customerId: customer, currency: 'USD', balance: 0 });
  });
});

describe('POST /topups and GET /topups/:id', () => {
  const post = (customer: string, key: string | undefined, payload: unknown, tenant = 'acme') =>
    app.inject({
      method: 'POST',
      url: '/topups',
      headers: { ...who(tenant, customer), ...(key === undefined ? {} : { 'idempotency-key': key }) },
      payload: payload as object,
    });

  it('accepts a topup with 202 REQUESTED and triggers one submission', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const res = await post(customer, 'key-1', { amount: 150000 });
    expect(res.statusCode).toBe(202);
    const body = res.json<{ topupId: string }>();
    expect(body).toEqual({
      topupId: expect.stringMatching(/^tp_/),
      status: 'REQUESTED',
      amount: 150000,
      currency: 'VND',
      createdAt: '2026-10-10T10:00:00.000Z',
    });
    expect(submitted).toEqual([{ tenant: 'acme', topupId: body.topupId }]);
  });

  it('replays the stored response for the same key and body, and rejects reuse with another body', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const first = await post(customer, 'key-1', { amount: 500 });
    const replay = await post(customer, 'key-1', { amount: 500 });
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(submitted).toHaveLength(1);
    const reused = await post(customer, 'key-1', { amount: 501 });
    expect(reused.statusCode).toBe(422);
    expect(errorOf(reused.body).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('requires a well-formed Idempotency-Key', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const missing = await post(customer, undefined, { amount: 10 });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing.body).code).toBe('MISSING_IDEMPOTENCY_KEY');
    for (const key of ['', ' padded', 'padded ', 'k'.repeat(256)]) {
      const res = await post(customer, key, { amount: 10 });
      expect(res.statusCode, `key ${JSON.stringify(key)}`).toBe(400);
      expect(errorOf(res.body).code).toBe(key === '' ? 'MISSING_IDEMPOTENCY_KEY' : 'INVALID_IDEMPOTENCY_KEY');
    }
    expect((await post(customer, 'k'.repeat(255), { amount: 10 })).statusCode).toBe(202);
  });

  it.each([
    ['zero', { amount: 0 }],
    ['negative', { amount: -5 }],
    ['fractional', { amount: 10.5 }],
    ['a string', { amount: '100' }],
    ['missing', {}],
    ['null', { amount: null }],
  ])('rejects an amount that is %s with 400 INVALID_REQUEST', async (_name, payload) => {
    const customer = newCustomer();
    await createWallet(customer);
    const res = await post(customer, `key-${_name}`, payload);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res.body).code).toBe('INVALID_REQUEST');
    expect(submitted).toHaveLength(0);
  });

  it('answers 404 WALLET_NOT_FOUND when there is no wallet, and never uses a currency from the body', async () => {
    const missing = await post(newCustomer(), 'key-1', { amount: 10 });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('WALLET_NOT_FOUND');

    const customer = newCustomer();
    await createWallet(customer, 'VND');
    const res = await post(customer, 'key-1', { amount: 10, currency: 'USD' });
    expect(res.json()).toMatchObject({ currency: 'VND' });
  });

  it('shows a topup to its owner only: not to another customer, not to another tenant', async () => {
    const customer = newCustomer();
    await createWallet(customer);
    const { topupId } = (await post(customer, 'key-1', { amount: 900 })).json<{ topupId: string }>();
    const get = (tenant: string, who_: string) =>
      app.inject({ method: 'GET', url: `/topups/${topupId}`, headers: who(tenant, who_) });

    const own = await get('acme', customer);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toStrictEqual({
      topupId,
      status: 'REQUESTED',
      amount: 900,
      currency: 'VND',
      createdAt: '2026-10-10T10:00:00.000Z',
    });
    for (const other of [get('acme', newCustomer()), get('beta', customer)]) {
      const res = await other;
      expect(res.statusCode).toBe(404);
      expect(errorOf(res.body).code).toBe('TOPUP_NOT_FOUND');
    }
  });
});

describe('GET /wallet/entries', () => {
  /** Tạo ví rồi nạp thật `count` lần (100, 200, 300…) qua `ApplyPaymentResult` để sổ cái và số dư luôn khớp nhau. */
  async function walletWithEntries(count: number): Promise<string> {
    const customer = newCustomer();
    await createWallet(customer);
    const { applyPaymentResult } = buildDeps();
    for (let i = 0; i < count; i++) {
      const seeded = await seedTopup(h, { customer, amount: 100 * (i + 1) });
      await applyPaymentResult.execute({
        tenant: h.acme,
        eventId: `evt_entries_${customer}_${i}`,
        type: 'charge.succeeded',
        chargeId: seeded.chargeId,
        reference: seeded.topupId,
        amount: seeded.amount,
        currency: seeded.currency,
      });
    }
    return customer;
  }
  const list = (customer: string, query = '') =>
    app.inject({ method: 'GET', url: `/wallet/entries${query}`, headers: who('acme', customer) });

  it('pages through the entries in order with a cursor', async () => {
    const customer = await walletWithEntries(3);
    const first = (await list(customer, '?limit=2')).json<{ items: Array<{ businessKey: string; amount: number }>; nextCursor: string | null }>();
    expect(first.items.map((i) => i.amount)).toEqual([100, 200]);
    expect(first.nextCursor).toMatch(/^\d+$/);
    const second = (await list(customer, `?limit=2&cursor=${first.nextCursor}`)).json<{ items: Array<{ amount: number }>; nextCursor: string | null }>();
    expect(second.items.map((i) => i.amount)).toEqual([300]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(['?limit=0', '?limit=1001', '?limit=abc', '?limit=1.5', '?limit=1&limit=2', '?cursor=abc', '?cursor=-1'])(
    'rejects the query %s with 400 INVALID_QUERY',
    async (query) => {
      const customer = await walletWithEntries(1);
      const res = await list(customer, query);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res.body).code).toBe('INVALID_QUERY');
    },
  );

  it('answers 404 WALLET_NOT_FOUND for a customer without a wallet', async () => {
    const res = await list(newCustomer());
    expect(res.statusCode).toBe(404);
    expect(errorOf(res.body).code).toBe('WALLET_NOT_FOUND');
  });
});

describe('POST /webhooks/payment', () => {
  const nowSeconds = () => Math.floor(h.clock.now().getTime() / 1000);
  const iso = () => h.clock.now().toISOString();

  /** Thân webhook cố ý có khoảng trắng và thụt lề để chứng minh chữ ký được kiểm trên thân thô. */
  const body = (seeded: { topupId: string; chargeId: string; amount: number; currency: string }, overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
    JSON.stringify(
      {
        eventId: `evt_api_${++counter}`,
        type: 'charge.succeeded',
        createdAt: iso(),
        data: {
          chargeId: seeded.chargeId,
          reference: seeded.topupId,
          amount: seeded.amount,
          currency: seeded.currency,
          status: 'SUCCEEDED',
          completedAt: iso(),
          metadata: { tenantId: 'acme' },
          ...data,
        },
        ...overrides,
      },
      null,
      2,
    );

  /** `signature = null` nghĩa là không gửi header chữ ký; bỏ trống thì ký đúng như payment. */
  const hook = (raw: string, signature: string | null = signWebhook(SECRET, raw, nowSeconds())) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/payment',
      headers: { 'content-type': 'application/json', ...(signature === null ? {} : { 'x-signature': signature }) },
      payload: raw,
    });
  const balanceOf = async (customer: string): Promise<number> =>
    Number(
      (await h.db.withSchema('t_acme').selectFrom('accounts').select('balance').where('id', '=', `wallet:${customer}`).executeTakeFirstOrThrow()).balance,
    );
  const statusOf = async (topupId: string): Promise<string> =>
    (await h.db.withSchema('t_acme').selectFrom('topups').select('status').where('id', '=', topupId).executeTakeFirstOrThrow()).status;

  it('credits the wallet for a correctly signed charge.succeeded, with no tenant headers', async () => {
    const seeded = await seedTopup(h);
    const res = await hook(body(seeded));
    expect(res.statusCode).toBe(200);
    expect(await statusOf(seeded.topupId)).toBe('SUCCEEDED');
    expect(await balanceOf(seeded.customer)).toBe(150000);
  });

  it('answers 200 and applies nothing for a repeated delivery', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    expect((await hook(raw)).statusCode).toBe(200);
    expect((await hook(raw)).statusCode).toBe(200);
    expect(await balanceOf(seeded.customer)).toBe(150000);
  });

  it('fails the topup for charge.failed', async () => {
    const seeded = await seedTopup(h);
    const res = await hook(body(seeded, { type: 'charge.failed' }, { status: 'FAILED', failureCode: 'card_declined' }));
    expect(res.statusCode).toBe(200);
    expect(await statusOf(seeded.topupId)).toBe('FAILED');
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('answers 200 for inconsistent events (unknown topup, amount mismatch) so payment stops retrying', async () => {
    const seeded = await seedTopup(h);
    expect((await hook(body({ ...seeded, topupId: 'tp_missing' }))).statusCode).toBe(200);
    expect((await hook(body({ ...seeded, amount: seeded.amount + 1 }))).statusCode).toBe(200);
    expect(await statusOf(seeded.topupId)).toBe('PENDING');
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('rejects a missing, malformed or wrong signature with 401 INVALID_SIGNATURE and applies nothing', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const wrongSecret = signWebhook('another-secret', raw, nowSeconds());
    for (const signature of [null, 'garbage', wrongSecret]) {
      const res = await hook(raw, signature);
      expect(res.statusCode, String(signature)).toBe(401);
      expect(errorOf(res.body).code).toBe('INVALID_SIGNATURE');
    }
    expect(await statusOf(seeded.topupId)).toBe('PENDING');
  });

  it('rejects a body that was modified after signing, even by a single character', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const signature = signWebhook(SECRET, raw, nowSeconds());
    const res = await hook(raw.replace('"amount": 150000', '"amount": 150001'), signature);
    expect(res.statusCode).toBe(401);
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('rejects a replay whose timestamp is outside the tolerance', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const stale = signWebhook(SECRET, raw, nowSeconds() - 301);
    const res = await hook(raw, stale);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res.body).code).toBe('INVALID_SIGNATURE');
    expect(await balanceOf(seeded.customer)).toBe(0);
  });

  it('rejects a correctly signed payload that is invalid or points to an unknown tenant with 400 INVALID_WEBHOOK', async () => {
    const seeded = await seedTopup(h);
    const cases: Array<[string, string]> = [
      ['no metadata', body(seeded, {}, { metadata: undefined })],
      ['no tenantId', body(seeded, {}, { metadata: { other: 'x' } })],
      ['an unknown tenant', body(seeded, {}, { metadata: { tenantId: 'ghost' } })],
      ['a malformed tenant', body(seeded, {}, { metadata: { tenantId: "acme'--" } })],
      ['a failed event without failureCode', body(seeded, { type: 'charge.failed' }, { status: 'FAILED' })],
      ['a payload that is not a charge event', JSON.stringify({ hello: 'world' })],
    ];
    for (const [name, raw] of cases) {
      const res = await hook(raw);
      expect(res.statusCode, name).toBe(400);
      expect(errorOf(res.body).code, name).toBe('INVALID_WEBHOOK');
    }
    expect(await statusOf(seeded.topupId)).toBe('PENDING');
  });

  it('never puts the secret or a signature in a response or a log line', async () => {
    const seeded = await seedTopup(h);
    const raw = body(seeded);
    const signature = signWebhook(SECRET, raw, nowSeconds());
    const responses = [await hook(raw, signature), await hook(raw, 'garbage'), await hook(raw, signWebhook('x', raw, nowSeconds()))];
    const everything = JSON.stringify({ bodies: responses.map((r) => r.body), headers: responses.map((r) => r.headers), logs });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(signature);
    expect(everything).not.toContain('v1=');
  });
});
```
Ghi chú cho người thực hiện: hai chỗ dễ lệch giữa môi trường và giả định của test này cần được xác nhận bằng cách chạy, không đoán — (a) `app.inject` với `payload` là chuỗi + `content-type: application/json` giữ nguyên byte của chuỗi (đã kiểm chứng ở probe `rawBody`); (b) `reply.code(...)` trong controller với `@Res({ passthrough: true })`. Nếu (b) không đổi được mã trạng thái, thay bằng `reply.status(...)` hoặc trả về qua `reply.code(...).send(...)` (không `passthrough`) và ghi vào báo cáo.

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration interface/http/api`
Expected: FAIL (không resolve được `./create-app.js` và `AppDeps`).

- [ ] **Step 4: Cài đặt lớp interface**

`services/wallet/src/interface/http/tokens.ts`:
```ts
export const TENANT_REGISTRY = Symbol('TENANT_REGISTRY');
export const CLOCK = Symbol('CLOCK');
export const LOGGER = Symbol('LOGGER');
export const WEBHOOK_SECRET = Symbol('WEBHOOK_SECRET');
export const CREATE_WALLET = Symbol('CREATE_WALLET');
export const GET_WALLET = Symbol('GET_WALLET');
export const LIST_ENTRIES = Symbol('LIST_ENTRIES');
export const REQUEST_TOPUP = Symbol('REQUEST_TOPUP');
export const GET_TOPUP = Symbol('GET_TOPUP');
export const APPLY_PAYMENT_RESULT = Symbol('APPLY_PAYMENT_RESULT');
```

`services/wallet/src/interface/http/errors.ts`:
```ts
import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { InvalidMoneyError } from '@billing/money';
import type { FastifyReply } from 'fastify';
import {
  IdempotencyConflictError,
  InvalidQueryError,
  MissingCustomerError,
  MissingTenantError,
  TopupNotFoundError,
  UnknownTenantError,
  WalletCurrencyConflictError,
  WalletNotFoundError,
} from '../../application/errors.js';
import type { Logger } from '../../application/ports.js';
import { InvalidCustomerError, InvalidTopupError } from '../../domain/errors.js';
import { LOGGER } from './tokens.js';

/** Lỗi do chính lớp HTTP phát hiện (thiếu/sai header hay body) trước khi vào use case. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MappedError {
  status: number;
  code: string;
  message: string;
}

const RULES: ReadonlyArray<{ matches: (error: unknown) => boolean; status: number; code: string }> = [
  { matches: (e) => e instanceof MissingTenantError, status: 400, code: 'MISSING_TENANT' },
  { matches: (e) => e instanceof UnknownTenantError, status: 403, code: 'UNKNOWN_TENANT' },
  { matches: (e) => e instanceof MissingCustomerError, status: 400, code: 'MISSING_CUSTOMER' },
  {
    matches: (e) =>
      e instanceof InvalidCustomerError || e instanceof InvalidMoneyError || e instanceof InvalidTopupError,
    status: 400,
    code: 'INVALID_REQUEST',
  },
  { matches: (e) => e instanceof InvalidQueryError, status: 400, code: 'INVALID_QUERY' },
  { matches: (e) => e instanceof WalletNotFoundError, status: 404, code: 'WALLET_NOT_FOUND' },
  { matches: (e) => e instanceof TopupNotFoundError, status: 404, code: 'TOPUP_NOT_FOUND' },
  { matches: (e) => e instanceof WalletCurrencyConflictError, status: 409, code: 'WALLET_CURRENCY_CONFLICT' },
  { matches: (e) => e instanceof IdempotencyConflictError, status: 422, code: 'IDEMPOTENCY_KEY_REUSED' },
];

const STATUS_CODES: Record<number, string> = {
  400: 'INVALID_REQUEST',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

function clientStatus(error: unknown): number | undefined {
  if (error instanceof HttpException) return error.getStatus();
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/** Thuần túy và có thể kiểm thử riêng: lỗi nào thành mã HTTP và mã lỗi nào. */
export function mapError(error: unknown): MappedError {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  for (const rule of RULES) {
    if (rule.matches(error)) {
      return { status: rule.status, code: rule.code, message: (error as Error).message };
    }
  }
  const status = clientStatus(error);
  if (status !== undefined && status < 500) {
    return {
      status,
      code: STATUS_CODES[status] ?? `HTTP_${status}`,
      message: error instanceof Error ? error.message : 'request failed',
    };
  }
  return { status: 500, code: 'INTERNAL', message: 'internal error' };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly log: Logger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const mapped = mapError(error);
    if (mapped.status >= 500) this.log.error({ err: error }, 'unhandled error');
    void reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
  }
}
```

`services/wallet/src/interface/http/caller.guard.ts`:
```ts
import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { MissingCustomerError } from '../../application/errors.js';
import type { TenantRegistry } from '../../application/ports.js';
import { CustomerId } from '../../domain/customer-id.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { TENANT_REGISTRY } from './tokens.js';

export interface Caller {
  tenant: TenantId;
  customerId: CustomerId;
}

type CallerRequest = FastifyRequest & { caller?: Caller };

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(',') : value;

/** Lấy tenant và khách từ header do gateway đặt; không bao giờ đọc từ body hay query. */
@Injectable()
export class CallerGuard implements CanActivate {
  constructor(@Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CallerRequest>();
    const tenant = this.registry.resolve(headerValue(request.headers['x-tenant-id']));
    const rawCustomer = headerValue(request.headers['x-customer-id']);
    if (rawCustomer === undefined || rawCustomer.trim() === '') {
      throw new MissingCustomerError('customer is required');
    }
    request.caller = { tenant, customerId: CustomerId.parse(rawCustomer) };
    return true;
  }
}

export const CurrentCaller = createParamDecorator((_data: unknown, context: ExecutionContext): Caller => {
  const caller = context.switchToHttp().getRequest<CallerRequest>().caller;
  if (!caller) throw new Error('CallerGuard did not run before CurrentCaller');
  return caller;
});
```

`services/wallet/src/interface/http/wallets.controller.ts`:
```ts
import { Body, Controller, Get, Inject, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { CreateWallet } from '../../application/create-wallet.js';
import { InvalidQueryError } from '../../application/errors.js';
import type { GetWallet } from '../../application/get-wallet.js';
import type { ListEntries } from '../../application/list-entries.js';
import { CallerGuard, CurrentCaller, type Caller } from './caller.guard.js';
import { ApiError } from './errors.js';
import { CREATE_WALLET, GET_WALLET, LIST_ENTRIES } from './tokens.js';

@Controller()
@UseGuards(CallerGuard)
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: Pick<CreateWallet, 'execute'>,
    @Inject(GET_WALLET) private readonly getWallet: Pick<GetWallet, 'execute'>,
    @Inject(LIST_ENTRIES) private readonly listEntries: Pick<ListEntries, 'execute'>,
  ) {}

  @Post('wallets')
  async create(
    @CurrentCaller() caller: Caller,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'body must be a JSON object');
    }
    const { currency } = body as { currency?: unknown };
    if (typeof currency !== 'string') {
      throw new ApiError(400, 'INVALID_REQUEST', 'currency must be a string');
    }
    const { created, wallet } = await this.createWallet.execute({
      tenant: caller.tenant,
      customerId: caller.customerId,
      currency,
    });
    void reply.code(created ? 201 : 200);
    return wallet;
  }

  @Get('wallet')
  get(@CurrentCaller() caller: Caller) {
    return this.getWallet.execute({ tenant: caller.tenant, customerId: caller.customerId });
  }

  @Get('wallet/entries')
  entries(
    @CurrentCaller() caller: Caller,
    @Query('limit') limit?: string | string[],
    @Query('cursor') cursor?: string | string[],
  ) {
    if (Array.isArray(limit) || Array.isArray(cursor)) {
      throw new InvalidQueryError('limit and cursor must each be given at most once');
    }
    return this.listEntries.execute({
      tenant: caller.tenant,
      customerId: caller.customerId,
      limit: limit === undefined ? undefined : Number(limit),
      cursor,
    });
  }
}
```

`services/wallet/src/interface/http/topups.controller.ts`:
```ts
import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import type { GetTopup } from '../../application/get-topup.js';
import type { RequestTopup } from '../../application/request-topup.js';
import { CallerGuard, CurrentCaller, type Caller } from './caller.guard.js';
import { ApiError } from './errors.js';
import { GET_TOPUP, REQUEST_TOPUP } from './tokens.js';

const MAX_KEY_LENGTH = 255;

function readIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new ApiError(400, 'MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
  }
  if (raw.length > MAX_KEY_LENGTH || raw !== raw.trim()) {
    throw new ApiError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      `Idempotency-Key must be 1..${MAX_KEY_LENGTH} characters without leading or trailing whitespace`,
    );
  }
  return raw;
}

@Controller()
@UseGuards(CallerGuard)
export class TopupsController {
  constructor(
    @Inject(REQUEST_TOPUP) private readonly requestTopup: Pick<RequestTopup, 'execute'>,
    @Inject(GET_TOPUP) private readonly getTopup: Pick<GetTopup, 'execute'>,
  ) {}

  @Post('topups')
  @HttpCode(202)
  async create(
    @CurrentCaller() caller: Caller,
    @Headers('idempotency-key') rawKey: string | undefined,
    @Body() body: unknown,
  ) {
    const idempotencyKey = readIdempotencyKey(rawKey);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new ApiError(400, 'INVALID_REQUEST', 'body must be a JSON object');
    }
    const { amount } = body as { amount?: unknown };
    if (typeof amount !== 'number') {
      throw new ApiError(400, 'INVALID_REQUEST', 'amount must be a number');
    }
    const result = await this.requestTopup.execute({
      tenant: caller.tenant,
      customerId: caller.customerId,
      idempotencyKey,
      amount,
    });
    return result.body;
  }

  @Get('topups/:id')
  get(@CurrentCaller() caller: Caller, @Param('id') id: string) {
    return this.getTopup.execute({ tenant: caller.tenant, customerId: caller.customerId, topupId: id });
  }
}
```

`services/wallet/src/interface/http/webhooks.controller.ts`:
```ts
import { Controller, Headers, HttpCode, Inject, Post, Req, type RawBodyRequest } from '@nestjs/common';
import { validateChargeWebhook, verifyWebhook } from '@billing/contracts';
import type { FastifyRequest } from 'fastify';
import type { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { MissingTenantError, UnknownTenantError } from '../../application/errors.js';
import type { Clock, TenantRegistry } from '../../application/ports.js';
import { ApiError } from './errors.js';
import { APPLY_PAYMENT_RESULT, CLOCK, TENANT_REGISTRY, WEBHOOK_SECRET } from './tokens.js';

@Controller()
export class WebhooksController {
  constructor(
    @Inject(APPLY_PAYMENT_RESULT) private readonly applyPaymentResult: Pick<ApplyPaymentResult, 'execute'>,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WEBHOOK_SECRET) private readonly secret: string,
  ) {}

  /**
   * Thứ tự cố định: (1) chữ ký trên THÂN THÔ, (2) hình dạng payload, (3) tenant lấy từ payload ĐÃ KÝ,
   * (4) use case. Không bao giờ ghi hay trả lại chữ ký hoặc bí mật.
   */
  @Post('webhooks/payment')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
    @Headers('x-signature') signature: string | undefined,
  ) {
    const raw = request.rawBody?.toString('utf8') ?? '';
    const verdict = verifyWebhook({
      secret: this.secret,
      body: raw,
      header: signature,
      nowSeconds: Math.floor(this.clock.now().getTime() / 1000),
    });
    if (!verdict.ok) {
      throw new ApiError(401, 'INVALID_SIGNATURE', 'webhook signature is invalid');
    }

    const parsed = validateChargeWebhook(request.body);
    if (!parsed.ok) {
      throw new ApiError(400, 'INVALID_WEBHOOK', `webhook payload is invalid: ${parsed.errors.join('; ')}`);
    }
    const { payload } = parsed;

    let tenant;
    try {
      tenant = this.registry.resolve(payload.data.metadata?.tenantId);
    } catch (error) {
      if (error instanceof MissingTenantError || error instanceof UnknownTenantError) {
        throw new ApiError(400, 'INVALID_WEBHOOK', 'webhook does not identify a known tenant');
      }
      throw error;
    }

    const outcome = await this.applyPaymentResult.execute({
      tenant,
      eventId: payload.eventId,
      type: payload.type,
      chargeId: payload.data.chargeId,
      reference: payload.data.reference,
      amount: payload.data.amount,
      currency: payload.data.currency,
      failureCode: payload.data.failureCode,
    });
    return { outcome };
  }
}
```

`services/wallet/src/app.module.ts` (viết lại toàn bộ):
```ts
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { ApplyPaymentResult } from './application/apply-payment-result.js';
import type { CreateWallet } from './application/create-wallet.js';
import type { GetTopup } from './application/get-topup.js';
import type { GetWallet } from './application/get-wallet.js';
import type { ListEntries } from './application/list-entries.js';
import type { Clock, Logger, TenantRegistry } from './application/ports.js';
import type { RequestTopup } from './application/request-topup.js';
import { CorrelationMiddleware } from './interface/http/correlation.middleware.js';
import { AllExceptionsFilter } from './interface/http/errors.js';
import { HealthController } from './interface/http/health.controller.js';
import {
  APPLY_PAYMENT_RESULT,
  CLOCK,
  CREATE_WALLET,
  GET_TOPUP,
  GET_WALLET,
  LIST_ENTRIES,
  LOGGER,
  REQUEST_TOPUP,
  TENANT_REGISTRY,
  WEBHOOK_SECRET,
} from './interface/http/tokens.js';
import { TopupsController } from './interface/http/topups.controller.js';
import { WalletsController } from './interface/http/wallets.controller.js';
import { WebhooksController } from './interface/http/webhooks.controller.js';

export interface AppDeps {
  registry: TenantRegistry;
  clock: Clock;
  log: Logger;
  webhookSecret: string;
  createWallet: Pick<CreateWallet, 'execute'>;
  getWallet: Pick<GetWallet, 'execute'>;
  listEntries: Pick<ListEntries, 'execute'>;
  requestTopup: Pick<RequestTopup, 'execute'>;
  getTopup: Pick<GetTopup, 'execute'>;
  applyPaymentResult: Pick<ApplyPaymentResult, 'execute'>;
}

@Module({})
export class AppModule implements NestModule {
  /** Nối các use case đã dựng sẵn vào Nest bằng token tường minh (không dựa vào metadata kiểu). */
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, TopupsController, WebhooksController],
      providers: [
        { provide: TENANT_REGISTRY, useValue: deps.registry },
        { provide: CLOCK, useValue: deps.clock },
        { provide: LOGGER, useValue: deps.log },
        { provide: WEBHOOK_SECRET, useValue: deps.webhookSecret },
        { provide: CREATE_WALLET, useValue: deps.createWallet },
        { provide: GET_WALLET, useValue: deps.getWallet },
        { provide: LIST_ENTRIES, useValue: deps.listEntries },
        { provide: REQUEST_TOPUP, useValue: deps.requestTopup },
        { provide: GET_TOPUP, useValue: deps.getTopup },
        { provide: APPLY_PAYMENT_RESULT, useValue: deps.applyPaymentResult },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
```

`services/wallet/src/interface/http/create-app.ts`:
```ts
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule, type AppDeps } from '../../app.module.js';

/** Dựng ứng dụng Nest + Fastify, chưa `listen`. `rawBody` bật để webhook kiểm chữ ký trên byte gốc. */
export async function createApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(deps),
    new FastifyAdapter(),
    { rawBody: true, logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
```

`services/wallet/src/main.ts` hiện còn bản khung dùng `AppModule` trần; nó sẽ bị `AppModule.register` làm hỏng typecheck. Để commit này vẫn xanh, **tạm** thay toàn bộ nội dung `main.ts` bằng bản sau (Task 12 sẽ thay bằng bản thật có cấu hình, worker và tắt êm):
```ts
import { createLogger } from '@billing/observability';

createLogger('wallet').error({}, 'wallet is not wired yet; see bootstrap.ts (next task)');
process.exit(1);
```

- [ ] **Step 5: Chạy test, lint, typecheck**

```bash
corepack pnpm test:integration interface/http/api
corepack pnpm exec vitest run services/wallet/src/interface
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS. Nếu `forRoutes('*')` của middleware không áp dụng được ở phiên bản Nest hiện tại (test `x-correlation-id` đỏ), đổi sang `forRoutes({ path: '{*splat}', method: RequestMethod.ALL })` và ghi vào báo cáo. Nếu `request.body` trong `WebhooksController` không phải là object đã parse (bị Nest thay đổi), đọc nó bằng `@Body()` như probe và truyền vào `validateChargeWebhook`.

- [ ] **Step 6: Commit**

```bash
git add -A services/wallet pnpm-lock.yaml
git commit -m "feat(wallet): add Nest HTTP layer (caller guard, error mapping, controllers, raw-body webhook)"
```

### Task 12: Nối dây dịch vụ — `bootstrap`, worker, tắt êm, `main`, e2e cấp service

**Files:**
- Create: `packages/testing/src/free-port.ts`, `packages/testing/src/free-port.test.ts`, `services/wallet/src/application/inline-topup-submitter.ts`, `services/wallet/src/application/inline-topup-submitter.test.ts`, `services/wallet/src/bootstrap.ts`, `services/wallet/src/service.integration.test.ts`
- Modify: `packages/testing/src/index.ts`, `services/wallet/src/main.ts` (thay bản tạm của Task 11)

**Interfaces:**
- Consumes: mọi use case (Task 7–10), `createApp`/`AppDeps` (Task 11), `HttpPaymentGateway` (Task 9), `KyselyTenantUnitOfWork`, `provisionTenants`, `assertMigrated` (Task 5–6), `SystemClock`, `RandomIdGenerator`, `ConfigTenantRegistry`, `WalletConfig` (Task 3), `Worker`, `once`, `runAll`, `createShutdownHandler`, `startOrExit` từ `@billing/runtime`, `FakePaymentServer`, `FakeClock`, `createTestDatabase`, `waitFor` từ `@billing/testing`.
- Produces:
  - `getFreePort(): Promise<number>` (`@billing/testing`): cổng TCP trống trên `127.0.0.1` (mở cổng 0 rồi đóng); dùng khi hai service cần biết địa chỉ của nhau trước khi lắng nghe.
  - `class InlineTopupSubmitter implements TopupSubmitter` (`constructor(deps: { submit: Pick<SubmitTopup, 'executeFor'>; log: Logger })`): `submitSoon(tenant, topupId)` chạy `submit.executeFor` **không chờ**, bắt mọi lỗi (kể cả ném đồng bộ) và chỉ ghi log `error` (worker sẽ thử lại); `drain(): Promise<void>` đợi mọi lần thử đang chạy kết thúc (dùng khi tắt).
  - `interface StartOverrides { clock?: Clock; ids?: IdGenerator }`; `interface RunningService { app: NestFastifyApplication; stop(): Promise<void> }`; `startService(config: WalletConfig, overrides?: StartOverrides): Promise<RunningService>` — kiểm tra mọi tenant đã migrate (`assertMigrated`; lỗi thì đóng pool DB rồi ném), dựng toàn bộ use case, chạy một `Worker` (mỗi tick duyệt từng tenant, lỗi của một tenant được ghi log và không chặn tenant còn lại, truyền `shouldContinue` theo `AbortSignal`), **chưa** `listen`. `stop()` idempotent, thứ tự: dừng worker → đóng app → `drain` các lần thử gửi ngay → đóng pool DB; luôn chạy hết các bước và ném lại lỗi đầu tiên.

- [ ] **Step 1: Viết test thất bại cho `getFreePort` và `InlineTopupSubmitter` (unit)**

`packages/testing/src/free-port.test.ts`:
```ts
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { getFreePort } from './free-port.js';

const listenOn = (port: number) =>
  new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

describe('getFreePort', () => {
  it('returns a port that can be bound right away', async () => {
    const port = await getFreePort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
    await close(await listenOn(port));
  });

  it('does not return a port that is currently in use', async () => {
    const first = await listenOn(await getFreePort());
    const taken = (first.address() as { port: number }).port;
    for (let i = 0; i < 5; i++) expect(await getFreePort()).not.toBe(taken);
    await close(first);
  });
});
```

`services/wallet/src/application/inline-topup-submitter.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { TenantId } from '../domain/tenant-id.js';
import { InlineTopupSubmitter } from './inline-topup-submitter.js';
import type { Logger } from './ports.js';

const acme = TenantId.parse('acme');

function setup(executeFor: (tenant: TenantId, topupId: string) => Promise<unknown>) {
  const errors: Array<{ details: object; message: string | undefined }> = [];
  const log: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: (details, message) => errors.push({ details, message }),
  };
  const calls: Array<[string, string]> = [];
  const submitter = new InlineTopupSubmitter({
    submit: {
      executeFor: (tenant, topupId) => {
        calls.push([tenant.value, topupId]);
        return executeFor(tenant, topupId) as never;
      },
    },
    log,
  });
  return { submitter, errors, calls };
}

describe('InlineTopupSubmitter', () => {
  it('starts the submission immediately and does not wait for it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { submitter, calls } = setup(() => gate);

    expect(submitter.submitSoon(acme, 'tp_1')).toBeUndefined();
    expect(calls).toEqual([['acme', 'tp_1']]);

    let drained = false;
    const draining = submitter.drain().then(() => (drained = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(drained).toBe(false);
    release();
    await draining;
    expect(drained).toBe(true);
  });

  it('logs a failed submission instead of letting it escape, and drain() still settles', async () => {
    const { submitter, errors } = setup(() => Promise.reject(new Error('boom')));
    submitter.submitSoon(acme, 'tp_2');
    await submitter.drain();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.details).toMatchObject({ tenantId: 'acme', topupId: 'tp_2' });
  });

  it('also survives an executeFor that throws synchronously', async () => {
    const { submitter, errors } = setup(() => {
      throw new Error('sync boom');
    });
    expect(() => submitter.submitSoon(acme, 'tp_3')).not.toThrow();
    await submitter.drain();
    expect(errors).toHaveLength(1);
  });

  it('resolves drain() immediately when nothing is running', async () => {
    const { submitter } = setup(() => Promise.resolve());
    await expect(submitter.drain()).resolves.toBeUndefined();
  });

  it('keeps going when the logger itself throws', async () => {
    const submitter = new InlineTopupSubmitter({
      submit: { executeFor: () => Promise.reject(new Error('boom')) },
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => {
          throw new Error('logger down');
        },
      },
    });
    submitter.submitSoon(acme, 'tp_4');
    await expect(submitter.drain()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Chạy để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/testing/src/free-port.test.ts services/wallet/src/application/inline-topup-submitter.test.ts`
Expected: FAIL (không resolve được hai module).

- [ ] **Step 3: Cài đặt**

`packages/testing/src/free-port.ts`:
```ts
import { createServer, type AddressInfo } from 'node:net';

/** Một cổng TCP đang trống trên 127.0.0.1. Có khoảng hở rất nhỏ giữa lúc đóng và lúc dùng; chỉ dùng cho test. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
```
Thêm vào `packages/testing/src/index.ts`: `export { getFreePort } from './free-port.js';`

`services/wallet/src/application/inline-topup-submitter.ts`:
```ts
import type { TenantId } from '../domain/tenant-id.js';
import type { Logger, TopupSubmitter } from './ports.js';
import type { SubmitTopup } from './submit-topup.js';

/**
 * Lần thử gửi ngay sau khi `POST /topups` commit. Không chờ, không làm hỏng request; nếu lỗi thì lần nạp vẫn
 * `REQUESTED` và worker sẽ gửi lại. Theo dõi các lần thử đang chạy để dịch vụ tắt không cắt ngang chúng.
 */
export class InlineTopupSubmitter implements TopupSubmitter {
  readonly #pending = new Set<Promise<void>>();

  constructor(private readonly deps: { submit: Pick<SubmitTopup, 'executeFor'>; log: Logger }) {}

  submitSoon(tenant: TenantId, topupId: string): void {
    const attempt: Promise<void> = (async () => {
      await this.deps.submit.executeFor(tenant, topupId);
    })()
      .catch((error: unknown) => {
        try {
          this.deps.log.error(
            { err: error, tenantId: tenant.value, topupId },
            'inline topup submission failed; the worker will retry',
          );
        } catch {
          // Logger hỏng không được phép biến thành lỗi chưa xử lý.
        }
      })
      .finally(() => {
        this.#pending.delete(attempt);
      });
    this.#pending.add(attempt);
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
```

`services/wallet/src/bootstrap.ts`:
```ts
import { createDatabase } from '@billing/database';
import { createLogger } from '@billing/observability';
import { Worker, once, runAll } from '@billing/runtime';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Kysely } from 'kysely';
import { ApplyPaymentResult } from './application/apply-payment-result.js';
import { CreateWallet } from './application/create-wallet.js';
import { GetTopup } from './application/get-topup.js';
import { GetWallet } from './application/get-wallet.js';
import { InlineTopupSubmitter } from './application/inline-topup-submitter.js';
import { ListEntries } from './application/list-entries.js';
import type { Clock, IdGenerator, Logger } from './application/ports.js';
import { RequestTopup } from './application/request-topup.js';
import { SubmitDueTopups } from './application/submit-due-topups.js';
import { SubmitTopup } from './application/submit-topup.js';
import type { WalletConfig } from './config.js';
import { HttpPaymentGateway } from './infrastructure/http-payment-gateway.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';
import { assertMigrated } from './infrastructure/kysely/provisioning.js';
import { KyselyTenantUnitOfWork } from './infrastructure/kysely/unit-of-work.js';
import { RandomIdGenerator, SystemClock } from './infrastructure/system.js';
import { ConfigTenantRegistry } from './infrastructure/tenant-registry.js';
import { createApp } from './interface/http/create-app.js';

export interface StartOverrides {
  clock?: Clock;
  ids?: IdGenerator;
}

export interface RunningService {
  app: NestFastifyApplication;
  stop(): Promise<void>;
}

/** Composition root: nối mọi thứ lại và chạy worker nền; app chưa `listen` (main.ts hoặc test tự làm). */
export async function startService(
  config: WalletConfig,
  overrides: StartOverrides = {},
): Promise<RunningService> {
  const pino = createLogger('wallet');
  const log: Logger = {
    info: (details, message) => pino.info(details, message),
    warn: (details, message) => pino.warn(details, message),
    error: (details, message) => pino.error(details, message),
  };
  const db = createDatabase<WalletDatabase>(config.database);

  try {
    // Từ chối chạy khi còn tenant chưa được cấp phát/migrate, kèm thông báo nêu rõ tenant nào còn thiếu gì.
    await assertMigrated(db as unknown as Kysely<unknown>, config.tenants);
  } catch (error) {
    await db.destroy().catch(() => undefined);
    throw error;
  }

  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new RandomIdGenerator();
  const registry = new ConfigTenantRegistry(config.tenants);
  const uow = new KyselyTenantUnitOfWork(db);
  const gateway = new HttpPaymentGateway({
    baseUrl: config.payment.baseUrl,
    timeoutMs: config.payment.timeoutMs,
  });

  const submit = new SubmitTopup({
    uow,
    gateway,
    clock,
    backoffSeconds: config.topupBackoffSeconds,
  });
  const submitter = new InlineTopupSubmitter({ submit, log });
  const submitDue = new SubmitDueTopups({ submit });

  let app: NestFastifyApplication;
  try {
    app = await createApp({
      registry,
      clock,
      log,
      webhookSecret: config.payment.webhookSecret,
      createWallet: new CreateWallet({ uow, clock }),
      getWallet: new GetWallet({ uow }),
      listEntries: new ListEntries({ uow }),
      requestTopup: new RequestTopup({ uow, clock, ids, submitter }),
      getTopup: new GetTopup({ uow }),
      applyPaymentResult: new ApplyPaymentResult({ uow, clock, ids, log }),
    });
  } catch (error) {
    await db.destroy().catch(() => undefined);
    throw error;
  }

  // Mỗi tick duyệt từng tenant; lỗi của một tenant không được chặn các tenant còn lại.
  const submitDueForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of registry.all()) {
      if (signal.aborted) return;
      try {
        await submitDue.execute(tenant, undefined, { shouldContinue: () => !signal.aborted });
      } catch (error) {
        log.error({ err: error, tenantId: tenant.value }, 'submitting due topups failed');
      }
    }
  };
  const worker = new Worker({
    intervalMs: config.workerIntervalMs,
    tasks: [submitDueForAllTenants],
    onError: (error) => log.error({ err: error }, 'worker task failed'),
  });
  worker.start();

  return {
    app,
    stop: once(() =>
      runAll([
        () => worker.stop(),
        () => app.close(),
        () => submitter.drain(),
        () => db.destroy(),
      ]),
    ),
  };
}
```

`services/wallet/src/main.ts` (thay toàn bộ nội dung bản tạm):
```ts
import 'reflect-metadata';
import { ConfigError } from '@billing/database';
import { createLogger } from '@billing/observability';
import { createShutdownHandler, startOrExit } from '@billing/runtime';
import { startService } from './bootstrap.js';
import { loadConfig, type WalletConfig } from './config.js';

const log = createLogger('wallet');

let config: WalletConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    log.error({ problems: error.problems }, 'invalid configuration, refusing to start');
    process.exit(1);
  }
  throw error;
}

const service = await startOrExit({
  start: () => startService(config),
  listen: (running) => running.app.listen(config.port, '0.0.0.0').then(() => {}),
  log,
  exit: (code) => process.exit(code),
});
if (!service) process.exit(1);
log.info({ port: config.port, tenants: config.tenants.map((t) => t.value) }, 'wallet service listening');

const shutdown = createShutdownHandler({
  stop: () => service.stop(),
  log,
  exit: (code) => process.exit(code),
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 4: Chạy lại test unit, lint, typecheck**

```bash
corepack pnpm exec vitest run packages/testing/src/free-port.test.ts services/wallet/src/application/inline-topup-submitter.test.ts
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS. Nếu `Worker`/`once`/`runAll` không có trong `@billing/runtime` thì Task 1 chưa hoàn tất: dừng và báo.

- [ ] **Step 5: Viết test e2e cấp service (wallet thật + payment giả + đồng hồ giả)**

`services/wallet/src/service.integration.test.ts`:
```ts
import { signWebhook } from '@billing/contracts';
import { createDatabase } from '@billing/database';
import {
  FakeClock,
  FakePaymentServer,
  createTestDatabase,
  waitFor,
  type TestDatabase,
} from '@billing/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startService, type RunningService } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import { TenantId } from './domain/tenant-id.js';
import { provisionTenants } from './infrastructure/kysely/provisioning.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';

const SECRET = 'whsec_service_e2e';
const acme = TenantId.parse('acme');
const beta = TenantId.parse('beta');

let testDb: TestDatabase;
let db: Kysely<WalletDatabase>;
let fake: FakePaymentServer;
let clock: FakeClock;
const running: RunningService[] = [];
let counter = 0;

beforeAll(async () => {
  testDb = await createTestDatabase('walletsvc');
  db = createDatabase<WalletDatabase>(testDb.config);
  await provisionTenants(db as unknown as Kysely<unknown>, [acme, beta]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});
beforeEach(async () => {
  fake = await FakePaymentServer.start();
  clock = new FakeClock('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await fake.close();
  // Database dùng chung giữa các test: một lần nạp còn REQUESTED sẽ bị worker của test sau nhặt nhầm.
  for (const schema of ['t_acme', 't_beta']) {
    await db
      .withSchema(schema)
      .updateTable('topups')
      .set({ status: 'FAILED', failure_code: 'TEST_CLEANUP', next_attempt_at: null })
      .where('status', '=', 'REQUESTED')
      .execute();
  }
});

const configFor = (overrides: Partial<WalletConfig> = {}): WalletConfig => ({
  port: 0,
  database: testDb.config,
  tenants: [acme, beta],
  payment: { baseUrl: fake.baseUrl, webhookSecret: SECRET, timeoutMs: 1000 },
  topupBackoffSeconds: [1, 5],
  workerIntervalMs: 20,
  ...overrides,
});

async function start(overrides: Partial<WalletConfig> = {}): Promise<RunningService> {
  const service = await startService(configFor(overrides), { clock });
  running.push(service);
  return service;
}

const callerHeaders = (tenant: string, customer: string) => ({
  'x-tenant-id': tenant,
  'x-customer-id': customer,
});
const newCustomer = () => `svc${++counter}`;

async function openWallet(service: RunningService, customer: string, tenant = 'acme'): Promise<void> {
  const res = await service.app.inject({
    method: 'POST',
    url: '/wallets',
    headers: callerHeaders(tenant, customer),
    payload: { currency: 'VND' },
  });
  expect(res.statusCode).toBe(201);
}

async function requestTopup(
  service: RunningService,
  customer: string,
  { tenant = 'acme', amount = 150000, key = 'key-1' } = {},
): Promise<string> {
  const res = await service.app.inject({
    method: 'POST',
    url: '/topups',
    headers: { ...callerHeaders(tenant, customer), 'idempotency-key': key },
    payload: { amount },
  });
  expect(res.statusCode).toBe(202);
  return res.json<{ topupId: string }>().topupId;
}

const rowOf = (tenant: string, topupId: string) =>
  db.withSchema(`t_${tenant}`).selectFrom('topups').selectAll().where('id', '=', topupId).executeTakeFirstOrThrow();
const statusOf = async (topupId: string, tenant = 'acme') => (await rowOf(tenant, topupId)).status;
const attemptsOf = async (topupId: string, tenant = 'acme') => Number((await rowOf(tenant, topupId)).attempts);

/** Gửi webhook đã ký như payment sẽ làm. */
function settle(service: RunningService, topupId: string, chargeId: string, tenant = 'acme', amount = 150000) {
  const now = clock.now().toISOString();
  const raw = JSON.stringify({
    eventId: `evt_svc_${++counter}`,
    type: 'charge.succeeded',
    createdAt: now,
    data: {
      chargeId,
      reference: topupId,
      amount,
      currency: 'VND',
      status: 'SUCCEEDED',
      completedAt: now,
      metadata: { tenantId: tenant },
    },
  });
  return service.app.inject({
    method: 'POST',
    url: '/webhooks/payment',
    headers: {
      'content-type': 'application/json',
      'x-signature': signWebhook(SECRET, raw, Math.floor(clock.now().getTime() / 1000)),
    },
    payload: raw,
  });
}

const walletOf = async (service: RunningService, customer: string, tenant = 'acme') =>
  (await service.app.inject({ method: 'GET', url: '/wallet', headers: callerHeaders(tenant, customer) })).json<{
    balance: number;
  }>();

describe('wallet service, end to end with a scripted payment', () => {
  it('sends the charge right after accepting the topup, then settles it from the signed webhook', async () => {
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await statusOf(topupId)) === 'PENDING');
    expect(fake.requests).toHaveLength(1);
    const [sent] = fake.requests;
    expect(sent).toMatchObject({ method: 'POST', url: '/charges' });
    expect(sent?.headers['idempotency-key']).toBe(`topup:acme:${topupId}`);
    expect(JSON.parse(sent?.body ?? '')).toEqual({
      amount: 150000,
      currency: 'VND',
      reference: topupId,
      metadata: { tenantId: 'acme' },
    });
    expect((await walletOf(service, customer)).balance).toBe(0);

    expect((await settle(service, topupId, 'ch_fake_1')).statusCode).toBe(200);
    expect(await statusOf(topupId)).toBe('SUCCEEDED');
    expect((await walletOf(service, customer)).balance).toBe(150000);

    const entries = await service.app.inject({
      method: 'GET',
      url: '/wallet/entries',
      headers: callerHeaders('acme', customer),
    });
    expect(entries.json<{ items: Array<{ businessKey: string; amount: number }> }>().items).toEqual([
      expect.objectContaining({ businessKey: `topup:${topupId}`, amount: 150000 }),
    ]);
    expect(fake.requests).toHaveLength(1);
  });

  it('retries on the backoff schedule with the same idempotency key until payment recovers', async () => {
    fake.enqueue({ status: 503 }, { status: 503 });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    // Đợi lần thất bại được ghi xong rồi mới tiến đồng hồ (nếu không `next_attempt_at` bị tính từ giờ mới).
    await waitFor(async () => (await attemptsOf(topupId)) === 1);
    expect(await statusOf(topupId)).toBe('REQUESTED');
    clock.advanceSeconds(1);
    await waitFor(async () => (await attemptsOf(topupId)) === 2);
    clock.advanceSeconds(5);
    await waitFor(async () => (await statusOf(topupId)) === 'PENDING');

    expect(fake.requests).toHaveLength(3);
    expect(new Set(fake.requests.map((r) => r.headers['idempotency-key'])).size).toBe(1);
    expect(await attemptsOf(topupId)).toBe(3);
  });

  it('does not retry before the backoff has elapsed', async () => {
    fake.enqueue({ status: 503 });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);
    await waitFor(async () => (await attemptsOf(topupId)) === 1);

    await new Promise((resolve) => setTimeout(resolve, 150));
    clock.advanceSeconds(0.5);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fake.requests).toHaveLength(1);
    expect(await statusOf(topupId)).toBe('REQUESTED');
  });

  it('fails the topup at once when payment rejects the request, and never retries it', async () => {
    fake.enqueue({ status: 422, body: { error: { code: 'INVALID_REQUEST', message: 'bad amount' } } });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await statusOf(topupId)) === 'FAILED');
    const res = await service.app.inject({
      method: 'GET',
      url: `/topups/${topupId}`,
      headers: callerHeaders('acme', customer),
    });
    expect(res.json()).toMatchObject({ status: 'FAILED', failureCode: 'PAYMENT_REJECTED' });
    clock.advanceSeconds(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.requests).toHaveLength(1);
  });

  it('gives up with PAYMENT_UNAVAILABLE once the backoff list is exhausted, yet a later webhook still credits the wallet', async () => {
    fake.setFallback(() => ({ status: 503 }));
    const service = await start({ topupBackoffSeconds: [1] });
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await attemptsOf(topupId)) === 1);
    clock.advanceSeconds(1);
    await waitFor(async () => (await statusOf(topupId)) === 'FAILED');
    expect((await rowOf('acme', topupId)).failure_code).toBe('PAYMENT_UNAVAILABLE');
    expect((await walletOf(service, customer)).balance).toBe(0);

    // Payment thực ra đã nhận charge (ví dụ ở lần timeout); webhook thành công đến muộn.
    expect((await settle(service, topupId, 'ch_late')).statusCode).toBe(200);
    expect(await statusOf(topupId)).toBe('SUCCEEDED');
    expect((await walletOf(service, customer)).balance).toBe(150000);
  });

  it('treats a payment that is too slow as unavailable, then retries with the same key', async () => {
    fake.enqueue({ status: 202, body: { chargeId: 'ch_slow' }, delayMs: 400 });
    const service = await start({ payment: { baseUrl: fake.baseUrl, webhookSecret: SECRET, timeoutMs: 100 } });
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);

    await waitFor(async () => (await attemptsOf(topupId)) === 1);
    expect(await statusOf(topupId)).toBe('REQUESTED');
    clock.advanceSeconds(1);
    await waitFor(async () => (await statusOf(topupId)) === 'PENDING');
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.headers['idempotency-key']).toBe(fake.requests[1]?.headers['idempotency-key']);
  });

  it('serves every configured tenant from one worker, sending each tenant id to payment', async () => {
    fake.enqueue({ status: 503 }, { status: 503 });
    const service = await start();
    const inAcme = newCustomer();
    const inBeta = newCustomer();
    await openWallet(service, inAcme, 'acme');
    await openWallet(service, inBeta, 'beta');
    const acmeTopup = await requestTopup(service, inAcme, { tenant: 'acme' });
    const betaTopup = await requestTopup(service, inBeta, { tenant: 'beta' });

    await waitFor(
      async () => (await attemptsOf(acmeTopup)) === 1 && (await attemptsOf(betaTopup, 'beta')) === 1,
    );
    clock.advanceSeconds(1);
    await waitFor(
      async () => (await statusOf(acmeTopup)) === 'PENDING' && (await statusOf(betaTopup, 'beta')) === 'PENDING',
    );
    const lastTwo = fake.requests.slice(-2).map((r) => (JSON.parse(r.body) as { metadata: { tenantId: string } }).metadata.tenantId);
    expect(lastTwo.sort()).toEqual(['acme', 'beta']);
  });

  it('lets an in-flight inline submission finish before it closes the database on stop()', async () => {
    fake.enqueue({ status: 202, body: { chargeId: 'ch_inflight' }, delayMs: 300 });
    const service = await start();
    const customer = newCustomer();
    await openWallet(service, customer);
    const topupId = await requestTopup(service, customer);
    await waitFor(() => fake.requests.length === 1);

    await service.stop();
    expect(await rowOf('acme', topupId)).toMatchObject({ status: 'PENDING', charge_id: 'ch_inflight' });
  });

  it('stop() can be called more than once, concurrently', async () => {
    const service = await start();
    await expect(Promise.all([service.stop(), service.stop()])).resolves.toBeDefined();
    await expect(service.stop()).resolves.toBeUndefined();
  });

  it('refuses to start when a configured tenant has not been migrated, naming the tenant', async () => {
    const bare = await createTestDatabase('walletbare');
    try {
      await expect(startService({ ...configFor(), database: bare.config }, { clock })).rejects.toThrow(
        /not migrated.*"acme".*001-ledger/,
      );
    } finally {
      await bare.drop();
    }
  });
});
```

- [ ] **Step 6: Chạy test e2e cấp service**

Run: `corepack pnpm test:integration wallet/src/service`
Expected: PASS. Nếu ca "stop() ... in-flight" đỏ vì `app.close()` làm Fastify từ chối request đang xử lý, kiểm tra thứ tự trong `stop()`; nếu ca "retries on the backoff schedule" chập chờn, nguyên nhân thường là tiến đồng hồ **trước** khi lần thất bại được ghi — các `waitFor` trên `attempts` đã chặn điều này, đừng thay bằng `sleep`.

- [ ] **Step 7: Chạy toàn bộ kiểm tra rồi commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && corepack pnpm test
git add -A packages/testing services/wallet
git commit -m "feat(wallet): wire the service (bootstrap, worker, graceful shutdown, main) with service-level e2e"
```

---

### Task 13: E2E giữa hai service (payment thật + wallet thật)

**Files:**
- Create: `tests/e2e/billing.integration.test.ts`

**Interfaces:**
- Consumes: `startService`/`RunningService` của payment (`services/payment/src/bootstrap.ts`) và của wallet (`services/wallet/src/bootstrap.ts`); `paymentMigrations` (`db/payment/migrations.ts`, đã gồm `002-metadata` từ Task 2); `TenantId`, `provisionTenants` của wallet; `createTestDatabase`, `getFreePort`, `waitFor` từ `@billing/testing`.
- Đặt ở thư mục gốc `tests/` (không phải trong `services/*/src`) nên không vi phạm luật cấm import chéo service của ESLint — đây là nơi duy nhất được phép biết cả hai service.

Hai service cần địa chỉ của nhau trước khi lắng nghe: payment lấy một cổng trống từ `getFreePort()`; wallet được cấu hình `PAYMENT_BASE_URL` trỏ vào cổng đó, lắng nghe ở cổng 0, rồi payment được cấu hình `WEBHOOK_URL` trỏ vào cổng thật của wallet.

- [ ] **Step 1: Viết test**

`tests/e2e/billing.integration.test.ts`:
```ts
import { createDatabase, migrate } from '@billing/database';
import { createTestDatabase, getFreePort, waitFor, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentMigrations } from '../../db/payment/migrations.js';
import {
  startService as startPayment,
  type RunningService as RunningPayment,
} from '../../services/payment/src/bootstrap.js';
import {
  startService as startWallet,
  type RunningService as RunningWallet,
} from '../../services/wallet/src/bootstrap.js';
import { TenantId } from '../../services/wallet/src/domain/tenant-id.js';
import { provisionTenants } from '../../services/wallet/src/infrastructure/kysely/provisioning.js';

const SECRET = 'whsec_cross_service';
const tenants = [TenantId.parse('acme'), TenantId.parse('beta')];

let paymentDb: TestDatabase;
let walletDb: TestDatabase;
let paymentAdmin: Kysely<unknown>;
let walletAdmin: Kysely<unknown>;
let payment: RunningPayment;
let wallet: RunningWallet;
let walletUrl: string;
let paymentUrl: string;

beforeAll(async () => {
  paymentDb = await createTestDatabase('e2e_payment');
  walletDb = await createTestDatabase('e2e_wallet');
  paymentAdmin = createDatabase<unknown>(paymentDb.config);
  walletAdmin = createDatabase<unknown>(walletDb.config);
  await migrate(paymentAdmin, paymentMigrations);
  await provisionTenants(walletAdmin, tenants);

  const paymentPort = await getFreePort();
  paymentUrl = `http://127.0.0.1:${paymentPort}`;
  wallet = await startWallet({
    port: 0,
    database: walletDb.config,
    tenants,
    payment: { baseUrl: paymentUrl, webhookSecret: SECRET, timeoutMs: 3000 },
    topupBackoffSeconds: [1, 2, 3],
    workerIntervalMs: 50,
  });
  await wallet.app.listen(0, '127.0.0.1');
  walletUrl = await wallet.app.getUrl();

  payment = await startPayment({
    port: paymentPort,
    database: paymentDb.config,
    webhook: { url: `${walletUrl}/webhooks/payment`, secret: SECRET, backoffSeconds: [1, 2, 3] },
    workerIntervalMs: 50,
    responseTimeoutMs: 1000,
  });
  await payment.app.listen({ port: paymentPort, host: '127.0.0.1' });
});

afterAll(async () => {
  await payment?.stop();
  await wallet?.stop();
  await paymentAdmin?.destroy();
  await walletAdmin?.destroy();
  await paymentDb?.drop();
  await walletDb?.drop();
});

interface Reply<T> {
  status: number;
  body: T;
}

async function call<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  options: { tenant: string; customer: string; key?: string; body?: unknown },
): Promise<Reply<T>> {
  const response = await fetch(`${walletUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': options.tenant,
      'x-customer-id': options.customer,
      ...(options.key === undefined ? {} : { 'idempotency-key': options.key }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: (await response.json()) as T };
}

const topupStatus = async (tenant: string, customer: string, topupId: string): Promise<string> =>
  (await call<{ status: string }>('GET', `/topups/${topupId}`, { tenant, customer })).body.status;

const waitForStatus = (tenant: string, customer: string, topupId: string, status: string) =>
  waitFor(async () => (await topupStatus(tenant, customer, topupId)) === status, {
    timeoutMs: 20_000,
    intervalMs: 100,
  });

async function chargeIdOf(tenant: string, topupId: string): Promise<string> {
  const result = await sql<{ charge_id: string }>`
    select charge_id from ${sql.id(`t_${tenant}`, 'topups')} where id = ${topupId}`.execute(walletAdmin);
  const chargeId = result.rows[0]?.charge_id;
  if (!chargeId) throw new Error(`topup ${topupId} has no charge id`);
  return chargeId;
}

async function openWalletAndTopup(
  tenant: string,
  customer: string,
  amount: number,
  key = 'key-1',
): Promise<string> {
  const created = await call('POST', '/wallets', { tenant, customer, body: { currency: 'VND' } });
  expect(created.status).toBe(201);
  const topup = await call<{ topupId: string }>('POST', '/topups', { tenant, customer, key, body: { amount } });
  expect(topup.status).toBe(202);
  return topup.body.topupId;
}

describe('wallet and payment together', () => {
  it('tops up a wallet from request to credited balance, with payment agreeing on the charge', async () => {
    const topupId = await openWalletAndTopup('acme', 'e2e-full', 150000);
    await waitForStatus('acme', 'e2e-full', topupId, 'SUCCEEDED');

    const balance = await call<{ balance: number }>('GET', '/wallet', { tenant: 'acme', customer: 'e2e-full' });
    expect(balance.body.balance).toBe(150000);
    const entries = await call<{ items: Array<{ businessKey: string; amount: number }> }>(
      'GET',
      '/wallet/entries',
      { tenant: 'acme', customer: 'e2e-full' },
    );
    expect(entries.body.items).toEqual([
      expect.objectContaining({ businessKey: `topup:${topupId}`, amount: 150000 }),
    ]);

    const chargeId = await chargeIdOf('acme', topupId);
    const charge = await (await fetch(`${paymentUrl}/charges/${chargeId}`)).json();
    expect(charge).toMatchObject({
      chargeId,
      reference: topupId,
      amount: 150000,
      currency: 'VND',
      status: 'SUCCEEDED',
      metadata: { tenantId: 'acme' },
    });
  });

  it('creates exactly one topup and one charge when the same Idempotency-Key arrives five times at once', async () => {
    await call('POST', '/wallets', { tenant: 'acme', customer: 'e2e-dup', body: { currency: 'VND' } });
    const replies = await Promise.all(
      Array.from({ length: 5 }, () =>
        call<{ topupId: string }>('POST', '/topups', {
          tenant: 'acme',
          customer: 'e2e-dup',
          key: 'same-key',
          body: { amount: 70000 },
        }),
      ),
    );
    expect(replies.every((r) => r.status === 202)).toBe(true);
    const ids = new Set(replies.map((r) => r.body.topupId));
    expect(ids.size).toBe(1);
    const [topupId] = [...ids] as [string];

    await waitForStatus('acme', 'e2e-dup', topupId, 'SUCCEEDED');
    expect((await call<{ balance: number }>('GET', '/wallet', { tenant: 'acme', customer: 'e2e-dup' })).body.balance).toBe(70000);

    const charges = await sql<{ n: number }>`select count(*) as n from charges where reference = ${topupId}`.execute(
      paymentAdmin,
    );
    expect(Number(charges.rows[0]?.n)).toBe(1);
  });

  it('keeps tenants apart: the same customer id in two tenants gets two independent wallets and charges', async () => {
    const [inAcme, inBeta] = await Promise.all([
      openWalletAndTopup('acme', 'e2e-shared', 40000),
      openWalletAndTopup('beta', 'e2e-shared', 90000),
    ]);
    await Promise.all([
      waitForStatus('acme', 'e2e-shared', inAcme, 'SUCCEEDED'),
      waitForStatus('beta', 'e2e-shared', inBeta, 'SUCCEEDED'),
    ]);

    const acmeBalance = await call<{ balance: number }>('GET', '/wallet', { tenant: 'acme', customer: 'e2e-shared' });
    const betaBalance = await call<{ balance: number }>('GET', '/wallet', { tenant: 'beta', customer: 'e2e-shared' });
    expect([acmeBalance.body.balance, betaBalance.body.balance]).toEqual([40000, 90000]);

    const acmeCharge = (await (await fetch(`${paymentUrl}/charges/${await chargeIdOf('acme', inAcme)}`)).json()) as {
      metadata?: { tenantId?: string };
    };
    const betaCharge = (await (await fetch(`${paymentUrl}/charges/${await chargeIdOf('beta', inBeta)}`)).json()) as {
      metadata?: { tenantId?: string };
    };
    expect([acmeCharge.metadata?.tenantId, betaCharge.metadata?.tenantId]).toEqual(['acme', 'beta']);

    const crossTenant = await call('GET', `/topups/${inAcme}`, { tenant: 'beta', customer: 'e2e-shared' });
    expect(crossTenant.status).toBe(404);
  });

  it('leaves the ledger balanced and equal to what payment settled, per tenant', async () => {
    for (const { value: tenant } of tenants) {
      const schema = `t_${tenant}`;
      const total = await sql<{ total: string | null }>`
        select sum(balance) as total from ${sql.id(schema, 'accounts')}`.execute(walletAdmin);
      expect(Number(total.rows[0]?.total ?? 0), `${tenant}: sum of all balances`).toBe(0);

      const unbalanced = await sql<{ transaction_id: string }>`
        select transaction_id from ${sql.id(schema, 'ledger_entries')}
        group by transaction_id having sum(amount) <> 0`.execute(walletAdmin);
      expect(unbalanced.rows, `${tenant}: unbalanced transactions`).toEqual([]);

      const walletTotal = await sql<{ total: string | null }>`
        select sum(balance) as total from ${sql.id(schema, 'accounts')} where kind = 'WALLET'`.execute(walletAdmin);
      const succeeded = await sql<{ charge_id: string }>`
        select charge_id from ${sql.id(schema, 'topups')} where status = 'SUCCEEDED'`.execute(walletAdmin);
      const chargeIds = succeeded.rows.map((row) => row.charge_id);
      const settled =
        chargeIds.length === 0
          ? { rows: [{ total: '0' }] }
          : await sql<{ total: string | null }>`
              select sum(amount) as total from charges
              where status = 'SUCCEEDED' and id in (${sql.join(chargeIds)})`.execute(paymentAdmin);
      expect(Number(walletTotal.rows[0]?.total ?? 0), `${tenant}: wallets vs payment settlement`).toBe(
        Number(settled.rows[0]?.total ?? 0),
      );
    }
  });
});
```
Lưu ý: bài kiểm tra cuối đọc trạng thái **sau** ba bài trước (cùng file, chạy tuần tự) nên không được đưa lên đầu. Đối soát đầy đủ theo ngày (so `GET /settlements`) thuộc Bước 5; ở đây chỉ chứng minh số dư ví khớp tổng charge thành công của payment.

- [ ] **Step 2: Chạy test**

Run: `corepack pnpm test:integration tests/e2e`
Expected: PASS trong khoảng 10–30 giây (charge của payment hoàn tất ngay, webhook gửi ngay). Nếu `wallet.app.getUrl()` trả địa chỉ IPv6 `[::1]` dù đã `listen(0, '127.0.0.1')`, thay bằng `` `http://127.0.0.1:${new URL(await wallet.app.getUrl()).port}` ``. Nếu ca idempotency 5 request đồng thời đỏ ở dòng đếm `charges`, đó là lỗi thật (hai lần gọi payment cho cùng lần nạp) — dừng và điều tra thay vì nới test.

- [ ] **Step 3: Kiểm tra toàn bộ và commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add tests
git commit -m "test: add cross-service e2e (real payment and real wallet)"
```

---

### Task 14: Tài liệu, ADR, `.env.example`, quyền migrator cho cả hai DB, đồng bộ spec

**Files:**
- Modify: `db/payment/migrate.ts`, `services/payment/.env.example`, `deploy/sql/init.sql`, `deploy/compose.billing.yml`, `deploy/.env.example`, `README.md`, `docs/architecture/README.md`, `docs/superpowers/specs/2026-10-10-wallet-core-design.md`
- Create: `services/wallet/src/env-example.test.ts`, `docs/adr/0006-tenant-schema-per-tenant.vi.md`, `docs/adr/0007-topup-hybrid-submit-and-layered-dedup.vi.md`

**Interfaces:**
- Consumes: `migratorConfigFromEnv` (Task 5), `loadConfig` (Task 3).
- Produces: `corepack pnpm db:migrate:payment` hỗ trợ `PAYMENT_MIGRATOR_DB_USER/PASSWORD` như wallet; `deploy/sql/init.sql` tạo hai login migrator (`billing_wallet_migrator`, `billing_payment_migrator`, thành viên `db_owner` của DB tương ứng); tài liệu và ADR phản ánh những gì đã làm.

- [ ] **Step 1: Test chống lệch giữa `.env.example` và `loadConfig`**

`services/wallet/src/env-example.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const text = readFileSync(fileURLToPath(new URL('../.env.example', import.meta.url)), 'utf8');
const example = Object.fromEntries(
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)] as const;
    }),
);

const filledRequired = {
  ...example,
  WALLET_DB_HOST: 'db',
  WALLET_DB_PASSWORD: 'secret',
  WALLET_TENANTS: 'acme,beta',
  PAYMENT_BASE_URL: 'http://payment:3002',
  PAYMENT_WEBHOOK_SECRET: 'whsec',
};

describe('services/wallet/.env.example', () => {
  it('documents exactly the variables the service and the migrate command read', () => {
    expect(Object.keys(example).sort()).toEqual(
      [
        'PAYMENT_BASE_URL',
        'PAYMENT_TIMEOUT_MS',
        'PAYMENT_WEBHOOK_SECRET',
        'PORT',
        'TOPUP_SUBMIT_BACKOFF',
        'WALLET_DB_HOST',
        'WALLET_DB_NAME',
        'WALLET_DB_PASSWORD',
        'WALLET_DB_PORT',
        'WALLET_DB_USER',
        'WALLET_MIGRATOR_DB_PASSWORD',
        'WALLET_MIGRATOR_DB_USER',
        'WALLET_TENANTS',
        'WORKER_INTERVAL_MS',
      ].sort(),
    );
  });

  it('is accepted by loadConfig once the blanks are filled in', () => {
    expect(() => loadConfig(filledRequired)).not.toThrow();
  });

  it('shows defaults that equal the defaults in code', () => {
    const onlyRequired = {
      WALLET_DB_HOST: 'db',
      WALLET_DB_NAME: example.WALLET_DB_NAME ?? '',
      WALLET_DB_USER: example.WALLET_DB_USER ?? '',
      WALLET_DB_PASSWORD: 'secret',
      WALLET_TENANTS: 'acme,beta',
      PAYMENT_BASE_URL: 'http://payment:3002',
      PAYMENT_WEBHOOK_SECRET: 'whsec',
    };
    expect(loadConfig(filledRequired)).toEqual(loadConfig(onlyRequired));
  });
});
```
Run: `corepack pnpm exec vitest run services/wallet/src/env-example.test.ts`
Expected: PASS ngay (Task 3 đã tạo `.env.example` đúng); nếu FAIL, sửa `.env.example` cho khớp chứ không sửa test.

- [ ] **Step 2: `db:migrate:payment` dùng tài khoản migrator**

Thay toàn bộ `db/payment/migrate.ts`:
```ts
import { ConfigError, createDatabase, migrate, migratorConfigFromEnv } from '@billing/database';
import { paymentMigrations } from './migrations.js';

try {
  // Migrator của Kysely cần tài khoản thuộc db_owner; tài khoản ứng dụng chỉ cần DML.
  const config = migratorConfigFromEnv('PAYMENT_DB', 'PAYMENT_MIGRATOR_DB', process.env);
  const db = createDatabase<unknown>(config);
  try {
    const applied = await migrate(db, paymentMigrations);
    console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'database is up to date');
  } finally {
    await db.destroy();
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
```
Thêm vào **cuối** `services/payment/.env.example`:
```

# Tài khoản có quyền db_owner chỉ dùng cho `corepack pnpm db:migrate:payment` (không dùng khi chạy service)
PAYMENT_MIGRATOR_DB_USER=
PAYMENT_MIGRATOR_DB_PASSWORD=
```
Run: `corepack pnpm db:migrate:payment` (không đặt biến nào). Expected: thoát mã `1`, in `Invalid configuration: PAYMENT_DB_HOST is required; ...`.

- [ ] **Step 3: Hai login migrator trong overlay `deploy/`**

Trong `deploy/sql/init.sql`: đổi dòng chú thích đầu thành
```sql
-- Chạy bằng sqlcmd với -v WALLET_DB_PASSWORD=... PAYMENT_DB_PASSWORD=... WALLET_MIGRATOR_PASSWORD=... PAYMENT_MIGRATOR_PASSWORD=...
```
chèn sau khối tạo hai login ứng dụng (sau dòng `GO` đứng sau `CREATE LOGIN [billing_payment_app] ...`):
```sql
IF SUSER_ID(N'billing_wallet_migrator') IS NULL
  CREATE LOGIN [billing_wallet_migrator] WITH PASSWORD = N'$(WALLET_MIGRATOR_PASSWORD)', CHECK_POLICY = OFF;
GO
IF SUSER_ID(N'billing_payment_migrator') IS NULL
  CREATE LOGIN [billing_payment_migrator] WITH PASSWORD = N'$(PAYMENT_MIGRATOR_PASSWORD)', CHECK_POLICY = OFF;
GO
```
và thêm vào cuối khối `USE [billing_wallet];` (sau ba dòng `ALTER ROLE ... [billing_wallet_app]`, trước `GO`):
```sql
IF USER_ID(N'billing_wallet_migrator') IS NULL CREATE USER [billing_wallet_migrator] FOR LOGIN [billing_wallet_migrator];
ALTER ROLE db_owner ADD MEMBER [billing_wallet_migrator];
```
và tương tự cuối khối `USE [billing_payment];`:
```sql
IF USER_ID(N'billing_payment_migrator') IS NULL CREATE USER [billing_payment_migrator] FOR LOGIN [billing_payment_migrator];
ALTER ROLE db_owner ADD MEMBER [billing_payment_migrator];
```
Trong `deploy/compose.billing.yml`, dịch vụ `billing-sql-init`: thêm hai biến vào `environment`
```yaml
      WALLET_MIGRATOR_PASSWORD: ${BILLING_WALLET_MIGRATOR_DB_PASSWORD:?set in deploy/.env}
      PAYMENT_MIGRATOR_PASSWORD: ${BILLING_PAYMENT_MIGRATOR_DB_PASSWORD:?set in deploy/.env}
```
và thay dòng `-v WALLET_DB_PASSWORD=...` trong lệnh bằng hai dòng (cùng thụt lề, vẫn trong một khối `>-`):
```yaml
        -v WALLET_DB_PASSWORD="$$WALLET_DB_PASSWORD" PAYMENT_DB_PASSWORD="$$PAYMENT_DB_PASSWORD"
        WALLET_MIGRATOR_PASSWORD="$$WALLET_MIGRATOR_PASSWORD" PAYMENT_MIGRATOR_PASSWORD="$$PAYMENT_MIGRATOR_PASSWORD"
```
Trong `deploy/.env.example` thêm dưới `BILLING_PAYMENT_DB_PASSWORD=`:
```
# Tài khoản db_owner chỉ để chạy migration (db:migrate:*); không cấp cho service khi chạy
BILLING_WALLET_MIGRATOR_DB_PASSWORD=
BILLING_PAYMENT_MIGRATOR_DB_PASSWORD=
```
Đồng thời thêm một câu vào đầu `deploy/compose.billing.yml` (trong khối chú thích): `# Migration chạy bằng login *_migrator (db_owner); service chạy bằng login *_app (chỉ DML).`

- [ ] **Step 4: Thử mô hình quyền trên một SQL Server tạm (không có Docker thì ghi rõ là chưa thử)**

Đây là bằng chứng thật cho cả chuỗi: `init.sql` (chạy lặp được) → migrate bằng migrator → service chạy bằng tài khoản chỉ có DML.
```bash
docker run -d --name billing-sql-probe -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Str0ng!Passw0rd' -p 14339:1433 mcr.microsoft.com/mssql/server:2022-latest
# đợi ~20 giây cho SQL Server sẵn sàng
docker cp deploy/sql/init.sql billing-sql-probe:/init.sql
for i in 1 2; do docker exec billing-sql-probe /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'Str0ng!Passw0rd' -C -b -v WALLET_DB_PASSWORD='W!pass1234' PAYMENT_DB_PASSWORD='P!pass1234' WALLET_MIGRATOR_PASSWORD='WM!pass1234' PAYMENT_MIGRATOR_PASSWORD='PM!pass1234' -i /init.sql; done
```
Expected: cả hai lần chạy đều thoát mã 0 (idempotent). Rồi:
```bash
export WALLET_DB_HOST=localhost WALLET_DB_PORT=14339 WALLET_DB_NAME=billing_wallet WALLET_DB_USER=billing_wallet_app WALLET_DB_PASSWORD='W!pass1234' WALLET_MIGRATOR_DB_USER=billing_wallet_migrator WALLET_MIGRATOR_DB_PASSWORD='WM!pass1234' WALLET_TENANTS=acme,beta
corepack pnpm db:migrate:wallet          # kỳ vọng: acme/beta applied 001-ledger, 002-topups
corepack pnpm db:migrate:wallet          # kỳ vọng: up to date
PAYMENT_DB_HOST=localhost PAYMENT_DB_PORT=14339 PAYMENT_DB_NAME=billing_payment PAYMENT_DB_USER=billing_payment_app PAYMENT_DB_PASSWORD='P!pass1234' PAYMENT_MIGRATOR_DB_USER=billing_payment_migrator PAYMENT_MIGRATOR_DB_PASSWORD='PM!pass1234' corepack pnpm db:migrate:payment
PAYMENT_BASE_URL=http://localhost:3999 PAYMENT_WEBHOOK_SECRET=probe PORT=3011 corepack pnpm --filter @billing/wallet-service start &
sleep 8
curl -s -i localhost:3011/health
curl -s -X POST localhost:3011/wallets -H 'content-type: application/json' -H 'x-tenant-id: acme' -H 'x-customer-id: probe-1' -d '{"currency":"VND"}'
curl -s localhost:3011/wallet -H 'x-tenant-id: acme' -H 'x-customer-id: probe-1'
kill %1; docker rm -f billing-sql-probe
```
Expected: `/health` 200; tạo ví `201` rồi đọc lại đúng; service khởi động được bằng login `billing_wallet_app` (không phải `db_owner`). Ghi kết quả (kể cả lỗi quyền nếu có, ví dụ thiếu quyền đọc bảng migration của schema tenant) vào báo cáo; nếu quyền thiếu, sửa `init.sql` chứ không nới quyền tài khoản ứng dụng lên `db_owner`.

- [ ] **Step 5: ADR**

`docs/adr/0006-tenant-schema-per-tenant.vi.md`:
```markdown
# ADR-0006: Mỗi tenant một schema trong database của wallet

**Trạng thái:** Chấp nhận — 2026-10-10

## Bối cảnh

Wallet phục vụ nhiều tenant của gateway ecommerce. Cùng một `customerId` ở hai tenant là hai người khác nhau, và
một lỗi lộ dữ liệu chéo tenant trong dịch vụ giữ tiền là không chấp nhận được.

## Quyết định

Mỗi tenant có schema riêng `t_<tenant>` trong database `billing_wallet`, chứa đủ bảng của wallet (tài khoản,
ledger, lần nạp, idempotency, inbox). Tenant lấy từ header `X-Tenant-Id` (API) hoặc từ `data.metadata.tenantId` của
webhook **sau khi** xác thực chữ ký, và phải nằm trong `WALLET_TENANTS`. Mọi truy cập DB đi qua
`TenantUnitOfWork.run(tenant, …)`: không có cách lấy repository mà không đưa `TenantId`; Kysely dùng `withSchema`, SQL
thô luôn dùng `sql.id(schema, tên)`. Migration chạy theo từng schema với bảng theo dõi nằm trong chính schema đó
(`migrationTableSchema`); khi khởi động wallet từ chối chạy nếu còn tenant chưa migrate. Thêm tenant = thêm vào
`WALLET_TENANTS`, chạy `db:migrate:wallet`, khởi động lại.

## Phương án đã loại

- Cột `tenant_id` trong bảng chung: mọi truy vấn phải nhớ điều kiện lọc, mọi khóa duy nhất phải mang thêm cột;
  quên một chỗ là lộ dữ liệu.
- Database riêng cho mỗi tenant: cô lập nhất nhưng nhân số kết nối, backup và migration theo số tenant.

## Hệ quả

`Migrator` của Kysely dùng `sp_getapplock` nên cần tài khoản thuộc `db_owner`: migration chạy bằng login migrator
riêng, service chạy bằng login chỉ có DML. Số schema tăng theo số tenant (phù hợp đến vài trăm); không có truy vấn
xuyên tenant — đối soát (Bước 5) lặp qua từng tenant. Danh sách tenant của wallet phải được thống nhất với cấu hình
gateway của ecommerce trước khi chạy thật.
```

`docs/adr/0007-topup-hybrid-submit-and-layered-dedup.vi.md`:
```markdown
# ADR-0007: Nạp tiền gọi payment kiểu lai và chống trùng nhiều lớp

**Trạng thái:** Chấp nhận — 2026-10-10

## Bối cảnh

Nạp tiền là thao tác gọi một hệ thống ngoài có thể chậm, lỗi hoặc gửi webhook trùng/muộn. Tiền không được ghi hai
lần, không được mất, và `POST /topups` phải trả lời nhanh.

## Quyết định

`POST /topups` trong một transaction ghi lần nạp `REQUESTED` và idempotency key, trả `202`, rồi **sau khi commit**
kích hoạt một lần thử gửi sang payment không chờ. Một worker định kỳ gửi lại các lần nạp `REQUESTED` đến hạn. Cả hai
dùng chung `SubmitTopup`: chiếm lần nạp bằng lease 60 giây (`UPDLOCK, READPAST`), gọi payment ngoài transaction với
`Idempotency-Key = topup:<tenant>:<topupId>`, ghi kết quả trong transaction mới (bỏ qua nếu webhook đã chốt trước).
Lỗi 4xx → `FAILED`/`PAYMENT_REJECTED` ngay; lỗi mạng, timeout, 5xx → retry theo `TOPUP_SUBMIT_BACKOFF`, hết lượt →
`FAILED`/`PAYMENT_UNAVAILABLE`. Webhook là nguồn sự thật về tiền: `charge.succeeded` đến muộn vẫn chuyển
`FAILED`/`PAYMENT_UNAVAILABLE` thành `SUCCEEDED` và ghi sổ.

Chống trùng khi ghi tiền theo lớp: idempotency key API `(customer, key)` + hash nội dung; idempotency key gửi payment;
inbox `processed_messages(eventId)`; trạng thái lần nạp + khóa dòng; `business_key = topup:<id>` duy nhất trong
ledger; `UPDLOCK` tài khoản theo thứ tự id; trigger bất biến và `CHECK` số dư.

## Phương án đã loại

- Gọi payment đồng bộ trong request: giữ kết nối và khóa khi payment chậm, mất kết quả khi lỗi giữa chừng.
- Chỉ dùng worker: trễ tối thiểu một chu kỳ cho mọi lần nạp.
- Outbox/message bus: hoãn sang Bước 4 (thanh toán order với ecommerce) nơi nó thật sự cần.

## Hệ quả

Nếu tiến trình chết giữa lúc gửi, lần nạp tự đến hạn lại sau lease và được gửi lại an toàn nhờ idempotency key của
payment. Một webhook có thể đến trước khi kết quả gọi được ghi; trạng thái `REQUESTED` vẫn được chốt đúng. Dừng
service chờ các lần thử gửi ngay đang chạy rồi mới đóng DB.
```

- [ ] **Step 6: `README.md` và `docs/architecture/README.md`**

Trong `README.md`:
1. Thay khối lệnh ở mục "Payment simulator" bước 1 bằng:
```bash
# 1. Tạo schema (DB billing_payment phải tồn tại; xem deploy/compose.billing.yml).
#    Migration cần tài khoản db_owner: đặt thêm PAYMENT_MIGRATOR_DB_USER/PASSWORD (để trống thì dùng tài khoản ứng dụng).
PAYMENT_DB_HOST=... PAYMENT_DB_NAME=billing_payment PAYMENT_DB_USER=... PAYMENT_DB_PASSWORD=... \
  PAYMENT_MIGRATOR_DB_USER=... PAYMENT_MIGRATOR_DB_PASSWORD=... \
  corepack pnpm db:migrate:payment
```
2. Thêm đoạn sau `X-Simulate` (cuối mục payment, trước `### Test`): "`POST /charges` nhận thêm `metadata` tùy chọn (tối đa 10 khóa chuỗi→chuỗi); payment lưu và trả lại trong `GET /charges/{id}`, webhook (`data.metadata`) và sao kê."
3. Thêm mục mới trước "### Test" (khối ngoài dùng bốn dấu backtick vì bên trong có khối ```bash):
````markdown
## Wallet

Ví nạp trước theo khách hàng và theo tenant, ledger ghi sổ kép bất biến, nạp tiền qua payment.
Thiết kế: [`docs/superpowers/specs/2026-10-10-wallet-core-design.md`](docs/superpowers/specs/2026-10-10-wallet-core-design.md);
quyết định: ADR-0002, ADR-0006, ADR-0007.

```bash
# 1. Cấp phát các tenant (tạo schema t_<tenant> rồi migrate; biến môi trường: services/wallet/.env.example)
WALLET_DB_HOST=... WALLET_DB_NAME=billing_wallet WALLET_DB_USER=... WALLET_DB_PASSWORD=... \
  WALLET_MIGRATOR_DB_USER=... WALLET_MIGRATOR_DB_PASSWORD=... WALLET_TENANTS=acme,beta \
  corepack pnpm db:migrate:wallet

# 2. Chạy service (từ chối khởi động nếu còn tenant chưa migrate)
corepack pnpm --filter @billing/wallet-service start
```

Gọi thử (tenant và khách do gateway đặt qua header):

```bash
H='-H x-tenant-id:acme -H x-customer-id:c1 -H content-type:application/json'
curl -s -X POST localhost:3001/wallets $H -d '{"currency":"VND"}'
curl -s -X POST localhost:3001/topups $H -H 'idempotency-key: demo-1' -d '{"amount":150000}'
curl -s localhost:3001/wallet $H
curl -s localhost:3001/wallet/entries $H
```

`POST /topups` luôn trả `202`; số dư tăng khi payment gửi webhook `charge.succeeded` về `POST /webhooks/payment`
(đặt `WEBHOOK_URL` của payment trỏ vào đó và dùng chung `WEBHOOK_SECRET` = `PAYMENT_WEBHOOK_SECRET`).
````
4. Đổi câu cuối của mục "Hạ tầng dùng chung" ("... trước khi làm Wallet core.") thành: "... trước khi chạy thật; danh sách tenant của wallet (`WALLET_TENANTS`) cũng phải khớp với các tenant của gateway ecommerce."

Trong `docs/architecture/README.md`:
1. Thay dòng bullet `- **Migration:** ...` bằng:
```markdown
- **Migration:** `Migrator` nằm ở `kysely/migration`; dùng `migrate(db, migrations, { migrationTableSchema? })` của
  `@billing/database`. `Migrator` dùng `sp_getapplock` nên **phải chạy bằng tài khoản thuộc `db_owner`** (login
  `*_migrator`, biến `*_MIGRATOR_DB_USER/PASSWORD`, đọc bằng `migratorConfigFromEnv`); service chạy bằng login chỉ có
  DML. Lúc khởi động chỉ kiểm tra bằng `pendingMigrations`/`assertMigrated` (chỉ đọc).
```
2. Thêm hai mục trước "## Kiểm thử":
```markdown
## Đa tenant (wallet)

Mỗi tenant một schema `t_<tenant>`. Tenant chỉ đến từ header do gateway đặt (API) hoặc từ metadata đã được ký
(webhook), qua `TenantRegistry`; không bao giờ từ body hay query. Mọi truy cập DB đi qua
`TenantUnitOfWork.run(tenant, …)`; Kysely dùng `withSchema`, SQL thô dùng `sql.id(schema, tên)` và tên schema luôn
dựng từ `TenantId` đã kiểm tra. Test tích hợp luôn dựng ít nhất hai tenant để bắt rò rỉ chéo tenant.

## `@billing/runtime`

`Worker` (vòng lặp nền có `AbortSignal`), `runAll`, `once`, `createShutdownHandler`, `startOrExit` dùng chung cho cả
hai service: dừng worker → đóng app → chờ việc đang chạy → đóng DB, luôn chạy hết các bước.
```

- [ ] **Step 7: Đồng bộ spec với những gì đã chốt khi lập kế hoạch**

Trong `docs/superpowers/specs/2026-10-10-wallet-core-design.md`:
- Mục 8, sau hàng `WORKER_INTERVAL_MS`, thêm:
```markdown
| `WALLET_MIGRATOR_DB_USER`, `WALLET_MIGRATOR_DB_PASSWORD` | Tài khoản `db_owner` chỉ dùng cho `db:migrate:wallet` (đặt cả hai hoặc không đặt); service không đọc | không có (tùy chọn) |
```
- Mục 3, ở hàng `POST /wallets`, đổi mô tả thành "…khách sai dạng → `400 INVALID_REQUEST`; `currency` không hỗ trợ → `400 INVALID_REQUEST`" nếu chưa có.
- Mục 11: thay cả danh sách rủi ro bằng:
```markdown
- **Đã kiểm chứng:** lấy body thô của NestJS + Fastify (`rawBody: true`, byte gốc được giữ nguyên); `withSchema` và `sql.id(schema, tên)` với SQL thô; `Migrator` với `migrationTableSchema`; `CREATE SCHEMA` bằng quyền `db_ddladmin`.
- **Phát hiện khi kiểm chứng:** `Migrator` của Kysely cần `db_owner` (`sp_getapplock`), nên có login migrator riêng cho cả hai DB (xem ADR-0006 và `deploy/sql/init.sql`); `db:migrate:payment` của Bước 2 cũng được sửa theo.
- **Còn mở:** instance SQL Server dùng chung cho DB billing (ADR-0004, không chặn bước này); đồng bộ danh sách tenant giữa gateway của ecommerce và `WALLET_TENANTS` trước khi chạy thật.
```

- [ ] **Step 8: Kiểm tra và commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && corepack pnpm test
git add -A db deploy docs services README.md
git commit -m "docs(wallet): ADRs, README, env examples, migrator logins for both databases, spec sync"
```
Nếu `format:check` báo lệch ở các file markdown/yaml vừa sửa, chạy `corepack pnpm exec prettier --write` đúng các file đó rồi kiểm tra lại.

---

### Task 15: Kiểm chứng toàn bộ và hoàn tất nhánh

**Files:** không tạo file mới (chỉ sửa lỗi phát hiện được, nếu có).

- [ ] **Step 1: Cài sạch và chạy mọi cổng kiểm tra**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm format:check
corepack pnpm test
```
Expected: tất cả PASS, không cảnh báo mới.

- [ ] **Step 2: Chạy toàn bộ test tích hợp (cần Docker)**

```bash
corepack pnpm test:integration
```
Expected: tất cả PASS (payment, `@billing/database`, wallet, `tests/e2e`). Nếu testcontainers báo lỗi Ryuk, đặt `TESTCONTAINERS_RYUK_DISABLED=true`. Chạy lại **một lần** nếu có test chập chờn do thời gian, và ghi rõ test nào; nếu lỗi lặp lại thì điều tra nguyên nhân, không thêm `retry`.

- [ ] **Step 3: Đối chiếu spec — mỗi yêu cầu có test**

Đối chiếu từng dòng dưới đây với test tương ứng đã chạy xanh ở Step 2; nếu dòng nào không có test, thêm test (không chỉnh spec cho khớp):

| Yêu cầu trong spec | Test chứng minh |
|---|---|
| Tenant/khách lấy từ header, không từ body/query; mã lỗi 400/403 | `interface/http/api.integration.test.ts` (nhóm `tenant and customer headers`) |
| Cô lập chéo tenant (ví, lần nạp, webhook) | `api.integration.test.ts`, `apply-payment-result.integration.test.ts`, `repositories.integration.test.ts`, `tests/e2e` |
| Ví cố định đồng tiền, tạo tường minh, tạo đồng thời chỉ một ví | `create-wallet.integration.test.ts` |
| `POST /topups` luôn `202`, idempotency (replay/xung đột/đồng thời) | `request-topup.integration.test.ts`, `api.integration.test.ts`, `tests/e2e` |
| Gọi payment lai: thử ngay + worker, lease, backoff, `PAYMENT_REJECTED`/`PAYMENT_UNAVAILABLE`, timeout | `submit-topup.integration.test.ts`, `submit-due-topups.integration.test.ts`, `service.integration.test.ts` |
| Webhook: chữ ký trên body thô, hết hạn, tenant từ payload đã ký, `200` cho trùng/lệch | `api.integration.test.ts` (nhóm `POST /webhooks/payment`) |
| Ghi sổ kép bất biến, bất biến tổng bằng 0, số dư = tổng dòng | `repositories.integration.test.ts`, `apply-payment-result.integration.test.ts` (`afterEach` kiểm bất biến), `tests/e2e` |
| Chống trùng nhiều lớp (inbox, khóa lần nạp, `business_key`, thứ tự khóa tài khoản) | `apply-payment-result.integration.test.ts` (8 webhook trùng, 2 sự kiện khác nhau, 6 lần nạp đồng thời) |
| Thành công đến muộn sau `PAYMENT_UNAVAILABLE`; `charge.failed` sau `SUCCEEDED` bị bỏ qua | `apply-payment-result.integration.test.ts`, `service.integration.test.ts` |
| Provisioning tenant, từ chối khởi động khi chưa migrate | `provisioning.integration.test.ts`, `service.integration.test.ts` |
| Payment trả `metadata` ở charge, webhook, sao kê | các test `*.metadata.*` của Task 2, `tests/e2e` |
| Tắt êm: chờ lần thử đang chạy rồi mới đóng DB | `service.integration.test.ts`, `inline-topup-submitter.test.ts` |

- [ ] **Step 4: Rà soát bí mật và dấu vết gỡ lỗi**

```bash
git grep -nE "console\.(log|debug)" -- 'services/wallet/src' 'packages' ':!*.test.ts' ':!db/*'
git grep -nE "whsec_|password|secret" -- 'services/wallet/src' ':!*.test.ts' ':!*.example'
git status --short
```
Expected: không có `console.*` ngoài script migrate; chỉ các tham chiếu hợp lệ tới cấu hình (`webhookSecret`, `password` của `DatabaseConfig`), không có giá trị bí mật thật; cây làm việc sạch (mọi thứ đã commit).

- [ ] **Step 5: Review toàn nhánh và hoàn tất**

Dispatch reviewer toàn nhánh (mô hình mạnh nhất) theo `subagent-driven-development`, sửa các phát hiện theo quy trình, rồi dùng `superpowers:finishing-a-development-branch`. **Không push và không merge nếu người dùng chưa yêu cầu rõ.**

