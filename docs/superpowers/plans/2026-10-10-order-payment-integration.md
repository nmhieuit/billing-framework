# Order Payment Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hiện thực Bước 4 theo spec `docs/superpowers/specs/2026-10-10-order-payment-integration-design.md`: wallet nhận `OrderReadyForPaymentV1` qua RabbitMQ, trừ ví một lần duy nhất cho mỗi order, báo kết quả bằng `OrderPaidV1`/`OrderPaymentFailedV1` qua transactional outbox; hợp đồng event (JSON Schema + Pact) và Pact Broker.

**Architecture:** Event JSON phẳng theo quy ước ecommerce (`packages/contracts`). `@billing/messaging` bọc `amqplib` 2.x (kết nối tự phục hồi, publisher confirm + `mandatory`, consumer có retry theo bậc TTL và DLQ). Trong wallet: `PayOrder` chạy trong MỘT transaction của schema tenant (inbox → khóa ví → sổ kép `ORDER_PAYMENT` → `order_payments` → outbox); relay outbox publish ngoài transaction bằng lease; consumer ánh xạ kết quả sang ack/retry/reject. Pact Broker dựng bằng compose overlay, Jenkins publish/verify/can-i-deploy khi có cấu hình.

**Tech Stack:** TypeScript strict, Node 22, `amqplib` 2.2.0, `@pact-foundation/pact` 17.1.4, Kysely + SQL Server, RabbitMQ 3 (testcontainers), Vitest 5, pnpm 9 qua `corepack pnpm`.

## Global Constraints

- Mọi lệnh pnpm: `corepack pnpm ...` (pnpm không có trên PATH). Test tích hợp: `corepack pnpm test:integration <bộ-lọc>` **không** có `--`; cần Docker; nếu testcontainers báo lỗi Ryuk đặt `TESTCONTAINERS_RYUK_DISABLED=true`. Heredoc trong bash hay hỏng: ghi file bằng công cụ Write/Edit.
- Event: JSON phẳng, camelCase, không envelope. Trường chung bắt buộc `eventId` (UUID), `occurredAtUtc` (ISO 8601 UTC), `tenantId`, `correlationId`. Tên `{Event}V{N}`, schema `{Event}.v{N}.schema.json` (JSON Schema 2020-12). Tolerant reader: bỏ qua trường lạ.
- Ba event và routing key: `OrderReadyForPaymentV1` → `order-ready-for-payment.v1` (orders → wallet); `OrderPaidV1` → `order-paid.v1`, `OrderPaymentFailedV1` → `order-payment-failed.v1` (wallet → orders). `reason` ∈ {`INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`}. `amount` là số nguyên ≥ 1 (minor unit), `currency` ∈ {`VND`, `USD`}.
- Broker: vhost `billing`; exchange topic bền `orders.events` và `billing.events` (do script init khai báo, wallet chỉ kiểm tra bằng passive check). Wallet tự khai báo `wallet.work`, `wallet.retry` (direct), queue `wallet.order-payments` (+ `.retry.<giây>`, `.dlq`). **Tuyệt đối không dùng default exchange (`amq.default`)** làm DLX hay để publish.
- Publish luôn `mandatory` + confirm; `NO_ROUTE` là thất bại (dòng outbox giữ `PENDING`, thử lại). Thuộc tính AMQP: `contentType application/json`, `messageId = eventId`, `type =` tên event, `persistent`, header `x-correlation-id`.
- Quyền RabbitMQ (khớp nguyên văn `BILLING_VHOST_PERMISSIONS` ở Task 2 và `deploy/scripts/init-rabbitmq.sh` ở Task 12): `billing_wallet` configure `^wallet\..*`, write `^(billing\.events|wallet\..*)$`, read `^(orders\.events|wallet\..*)$`; `ecommerce_orders` configure `^ecommerce\..*`, write `^(orders\.events|ecommerce\..*)$`, read `^(billing\.events|ecommerce\..*)$`.
- Trả order trong MỘT transaction của schema tenant, theo thứ tự: inbox `("orders-events", eventId)` → (đã trả? replay/CONFLICT) → ví/đồng tiền → khóa ví + `system:MERCHANT:<cur>` (`lockMany`, id tăng dần) → trừ/cộng → `ledger.post` (`ORDER_PAYMENT`, `business_key = order:<orderId>`) → `order_payments` → outbox. Chỉ lần trả **thành công** được ghi nhớ theo `orderId`; từ chối thì chỉ ghi outbox (`OrderPaymentFailedV1`) và transaction vẫn commit.
- `DuplicateKeyError`: nguồn `inbox` → `DUPLICATE` (ack); nguồn `ledger`/`order_payment` → rollback, chạy lại đúng một lần (sẽ thấy `order_payments` và phát lại `OrderPaidV1`).
- Không bí mật nào (mật khẩu RabbitMQ, token Pact) trong log, thông báo lỗi hay file được commit. Lớp `domain` chỉ import `@billing/money`; `application` không import framework/driver/`infrastructure`/`interface`; `interface` không import `infrastructure`; service không import code service khác (lint ép).
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (hoặc model thực hiện).

## Những điều đã kiểm chứng bằng thử nghiệm thật (code trong plan phụ thuộc vào chúng)

1. **`amqplib` 2.2.0** có sẵn type (`index.d.ts`), import được cả `import amqp from 'amqplib'` lẫn `import { connect } from 'amqplib'`. `connect({ protocol:'amqp', hostname, port, username, password, vhost }, socketOptions?)`. Tùy chọn **`recovery`** tự kết nối lại và gọi `setup(model)` sau MỖI lần kết nối (kể cả lần đầu); trong `setup` tạo lại channel, khai báo topology, bật consumer. Kiểm chứng: xóa kết nối bằng management API → sự kiện `disconnect` rồi `connect`, `setup` chạy lần 2, consumer nhận tiếp và confirm channel mới publish được. `connect(..., { recovery })` trả `RecoveringChannelModel` (có `waitForConnect`, sự kiện `connect`/`disconnect`/`error`; **phải** gắn listener `error`).
2. **Management API chỉ liệt kê kết nối sau ~5 giây** (số liệu thống kê trễ): helper xóa kết nối phải thăm dò đến khi thấy kết nối.
3. **Quyền hạn chế hoạt động như thiết kế:** user `billing_wallet` làm được `checkExchange('orders.events')` (passive, không cần configure), khai báo queue/exchange `wallet.*`, bind queue vào `orders.events`; bị `403 ACCESS_REFUSED` khi `assertExchange('rogue.exchange')` và khi publish vào `orders.events`.
4. **Default exchange cần quyền ghi `amq.default`:** khai báo queue có `x-dead-letter-exchange: ''` và `sendToQueue` đều bị `403 ... write access to exchange 'amq.default'`. Quyền đó cho phép ghi vào MỌI queue của vhost nên bị loại; thay bằng exchange `wallet.work`/`wallet.retry`. Topology này đã chạy thật.
5. **Retry theo bậc:** queue retry (TTL 1s, 2s) dead-letter về `wallet.work`; mốc quan sát: lần 0 tại 3 ms, lần 1 tại ~1007 ms, lần 2 tại ~3014 ms; sau bậc cuối publish vào `wallet.retry` key `dlq` → queue DLQ có đúng 1 message. Header `x-retry-count` do ta tự đặt được giữ nguyên.
6. **Không định tuyến được:** broker VẪN confirm; với `mandatory: true` nhận sự kiện `return` (`replyText = NO_ROUTE`) **trước** khi confirm; không `mandatory` thì message bị bỏ lặng lẽ. Confirm callback của message routable trả OK và bên nhận thấy `type`, `messageId`, `headers` nguyên vẹn.
7. **RabbitMQ container có thể mất >30 s để khởi động trên máy này:** bắt buộc `.withStartupTimeout(120_000)`; không dùng được `Ryuk` thì container rác phải dọn thủ công.
8. **Pact:** `@pact-foundation/pact@17.1.4` chạy dưới Vitest 5 (Node 22). `new MessageConsumerPact({ consumer, provider, dir, logLevel })` mặc định **pact spec 3.0.0** (khớp PactNet 5 của ecommerce, KHÔNG đặt `spec: 4`); `.given().expectsToReceive().withContent(matchers).withMetadata().verify(asynchronousBodyHandler(fn))` — `fn` nhận **thẳng body** (object). `MessageProviderPact({ provider, messageProviders: { '<description>': async () => body }, pactUrls: [file] })` hoặc `pactBrokerUrl` + `consumerVersionSelectors: [{ mainBranch: true }]` + `publishVerificationResult: true` + `providerVersion` + `providerVersionBranch`.
9. **Pact Broker thật:** `pactfoundation/pact-broker:latest` + `postgres:16-alpine` (env `PACT_BROKER_DATABASE_ADAPTER=postgres`, `PACT_BROKER_DATABASE_URL=postgres://user:pw@host/db`, `PACT_BROKER_BASIC_AUTH_USERNAME/PASSWORD`) sẵn sàng sau vài giây (`/diagnostic/status/heartbeat` = 200). CLI: `docker run --rm --network <net> -v <abs-path>:/pacts pactfoundation/pact-cli:latest pact-broker publish /pacts --consumer-app-version V --branch main --broker-base-url http://pact-broker:9292 --broker-username u --broker-password p`. Trên Git Bash (Windows) phải đặt `MSYS_NO_PATHCONV=1` và dùng đường dẫn kiểu Windows (`pwd -W`). `can-i-deploy --pacticipant wallet --version V` trả "no" khi pact chưa được verify, "yes" sau khi provider verify xong và publish kết quả.
10. **SQL Server:** `ALTER TABLE … DROP CONSTRAINT` rồi `ADD CONSTRAINT … CHECK (kind in ('TOPUP','ORDER_PAYMENT'))` trên bảng đã có dữ liệu và có trigger `instead of update, delete` chạy được; insert `BOGUS` vẫn bị lỗi `547`; `sys.check_constraints.is_not_trusted = 0`.

## File Structure

```
billing-framework/
├─ deploy/            compose.pact-broker.yml (mới), scripts/init-rabbitmq.sh (user ecommerce, exchange), compose.billing.yml, .env.example
├─ docs/              adr/0008-flat-event-contracts, 0009-order-payment-outbox-and-topology; integration/{orders-handoff,pact-broker}.vi.md
├─ tools/             rabbitmq-init.test.ts (chống lệch quyền script ↔ BILLING_VHOST_PERMISSIONS)
├─ Jenkinsfile        (thêm stage Pact, có điều kiện)
├─ packages/
│  ├─ contracts/      src/{events,validate,emit,index}.ts (event phẳng; xóa envelope.ts)
│  ├─ testing/        src/{rabbitmq,containers.global-setup}.ts (đổi tên từ sql-server.global-setup), provided-context.ts
│  └─ messaging/      (mới) src/{index,types,topology,publisher,consumer,client,testing}.ts + tests
└─ services/wallet/
   ├─ pact-fixtures/orders-wallet.json
   └─ src/
      ├─ config.ts  bootstrap.ts  test-support.ts  test-support-orders.ts
      ├─ domain/ledger-transaction.ts (+ORDER_PAYMENT)
      ├─ application/{pay-order,order-events,relay-outbox}.ts + ports.ts
      ├─ infrastructure/amqp-event-publisher.ts + kysely/{order-payment.repository,outbox.repository,schema,unit-of-work}.ts + kysely/migrations/003-orders.ts
      ├─ interface/messaging/{order-ready.decoder,order-ready.handler}.ts
      └─ contract/{wallet-consumer.pact.test.ts,wallet-provider.pact.integration.test.ts}
```

---

### Task 1: Contracts — ba event phẳng, bỏ envelope

**Files:**
- Modify: `packages/contracts/src/events.ts` (viết lại), `validate.ts` (viết lại), `emit.ts`, `index.ts`, `validate.test.ts` (viết lại), `emit.test.ts`, `tools/boundaries.test.ts`, `docs/adr/0001-json-contract-over-masstransit.vi.md`, `docs/superpowers/specs/2026-10-09-billing-framework-design.md` (mục 4)
- Delete: `packages/contracts/src/envelope.ts`
- Create: `docs/adr/0008-flat-event-contracts.vi.md`

**Interfaces:**
- Produces (`@billing/contracts`):
  - schema `orderReadyForPaymentV1`, `orderPaidV1`, `orderPaymentFailedV1` (đối tượng `as const`) và các kiểu `OrderReadyForPaymentV1`, `OrderPaidV1`, `OrderPaymentFailedV1` (`FromSchema`)
  - `eventCatalog`: `{ OrderReadyForPaymentV1: { schema, routingKey: 'order-ready-for-payment.v1', schemaFile: 'OrderReadyForPayment.v1.schema.json' }, OrderPaidV1: { …, routingKey: 'order-paid.v1', schemaFile: 'OrderPaid.v1.schema.json' }, OrderPaymentFailedV1: { …, routingKey: 'order-payment-failed.v1', schemaFile: 'OrderPaymentFailed.v1.schema.json' } }`; `type EventName = keyof typeof eventCatalog`; `interface EventPayloads { OrderReadyForPaymentV1: OrderReadyForPaymentV1; OrderPaidV1: OrderPaidV1; OrderPaymentFailedV1: OrderPaymentFailedV1 }`
  - `validateEvent<N extends EventName>(name: N, raw: unknown): ValidationResult<EventPayloads[N]>` với `type ValidationResult<T> = { ok: true; event: T } | { ok: false; errors: string[] }`
  - `emitSchemas(dir)`: ghi `OrderReadyForPayment.v1.schema.json`, `OrderPaid.v1.schema.json`, `OrderPaymentFailed.v1.schema.json` và `payment.charge-event.v1.json` (webhook, giữ nguyên)
  - **bị xóa:** `envelopeSchema`, `Envelope`, `eventSchemas`, `EventType`, `validateMessage`. Mã khác trong repo chỉ tham chiếu `validateMessage` trong một chuỗi của `tools/boundaries.test.ts` (không import thật).

- [ ] **Step 1: Viết test thất bại**

Thay toàn bộ `packages/contracts/src/validate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { eventCatalog, validateEvent } from './index.js';

const common = {
  eventId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  occurredAtUtc: '2026-10-10T10:00:00Z',
  tenantId: 'acme',
  correlationId: 'corr-1',
};

const ready = {
  ...common,
  orderId: '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11',
  customerId: 'cust-1',
  amount: 150000,
  currency: 'VND',
};

const paid = {
  ...common,
  orderId: ready.orderId,
  walletTransactionId: 'tx_1',
  amount: 150000,
  currency: 'VND',
  paidAtUtc: '2026-10-10T10:00:01Z',
};

const failed = { ...common, orderId: ready.orderId, reason: 'INSUFFICIENT_FUNDS' };

describe('validateEvent', () => {
  it('accepts a valid OrderReadyForPaymentV1 and returns it typed', () => {
    const result = validateEvent('OrderReadyForPaymentV1', ready);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.amount).toBe(150000);
  });

  it('accepts valid OrderPaidV1 and OrderPaymentFailedV1', () => {
    expect(validateEvent('OrderPaidV1', paid).ok).toBe(true);
    expect(validateEvent('OrderPaymentFailedV1', failed).ok).toBe(true);
  });

  it.each(['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'])(
    'accepts the failure reason %s',
    (reason) => {
      expect(validateEvent('OrderPaymentFailedV1', { ...failed, reason }).ok).toBe(true);
    },
  );

  it('rejects an unknown failure reason', () => {
    expect(validateEvent('OrderPaymentFailedV1', { ...failed, reason: 'BECAUSE' }).ok).toBe(false);
  });

  it('tolerates unknown extra fields (tolerant reader)', () => {
    expect(validateEvent('OrderReadyForPaymentV1', { ...ready, futureField: { x: 1 } }).ok).toBe(true);
    expect(validateEvent('OrderPaidV1', { ...paid, futureField: 'x' }).ok).toBe(true);
  });

  it.each([
    ['float amount', { amount: 10.5 }],
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -1 }],
    ['string amount', { amount: '100' }],
    ['unsupported currency', { currency: 'EUR' }],
    ['missing orderId', { orderId: undefined }],
    ['non-uuid orderId', { orderId: 'o-1' }],
    ['missing customerId', { customerId: undefined }],
    ['non-uuid eventId', { eventId: 'abc' }],
    ['bad timestamp', { occurredAtUtc: 'yesterday' }],
    ['missing tenantId', { tenantId: undefined }],
    ['empty tenantId', { tenantId: '' }],
    ['missing correlationId', { correlationId: undefined }],
  ])('rejects OrderReadyForPaymentV1 with %s', (_name, patch) => {
    expect(validateEvent('OrderReadyForPaymentV1', { ...ready, ...patch }).ok).toBe(false);
  });

  it.each([
    ['missing walletTransactionId', { walletTransactionId: undefined }],
    ['missing paidAtUtc', { paidAtUtc: undefined }],
    ['bad paidAtUtc', { paidAtUtc: 'later' }],
    ['float amount', { amount: 1.5 }],
  ])('rejects OrderPaidV1 with %s', (_name, patch) => {
    expect(validateEvent('OrderPaidV1', { ...paid, ...patch }).ok).toBe(false);
  });

  it('reports readable errors', () => {
    const result = validateEvent('OrderReadyForPaymentV1', { ...ready, amount: 0 });
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('/amount')] });
  });

  it('rejects non-object input', () => {
    expect(validateEvent('OrderPaidV1', null).ok).toBe(false);
    expect(validateEvent('OrderPaidV1', 'x').ok).toBe(false);
    expect(validateEvent('OrderPaidV1', [paid]).ok).toBe(false);
  });
});

describe('eventCatalog', () => {
  it('maps every event to its routing key and schema file', () => {
    expect(
      Object.entries(eventCatalog).map(([name, e]) => [name, e.routingKey, e.schemaFile]),
    ).toEqual([
      ['OrderReadyForPaymentV1', 'order-ready-for-payment.v1', 'OrderReadyForPayment.v1.schema.json'],
      ['OrderPaidV1', 'order-paid.v1', 'OrderPaid.v1.schema.json'],
      ['OrderPaymentFailedV1', 'order-payment-failed.v1', 'OrderPaymentFailed.v1.schema.json'],
    ]);
  });
});
```

Thay toàn bộ `packages/contracts/src/emit.test.ts`:
```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventCatalog, emitSchemas } from './index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'contracts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('emitSchemas', () => {
  it('writes one schema file per event plus the payment webhook schema', async () => {
    const written = await emitSchemas(dir);
    expect(written).toHaveLength(Object.keys(eventCatalog).length + 1);
    const paid = JSON.parse(await readFile(join(dir, 'OrderPaid.v1.schema.json'), 'utf8'));
    expect(paid).toEqual(eventCatalog.OrderPaidV1.schema);
    expect(paid.$id).toBe('urn:billing:schema:OrderPaid:v1');
    const webhook = JSON.parse(await readFile(join(dir, 'payment.charge-event.v1.json'), 'utf8'));
    expect(webhook.$id).toBe('urn:billing:schema:payment.charge-event:v1');
  });

  it('emits no envelope schema any more', async () => {
    await emitSchemas(dir);
    await expect(readFile(join(dir, 'envelope.v1.json'), 'utf8')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/contracts`
Expected: FAIL (`validateEvent`/`eventCatalog` chưa tồn tại).

- [ ] **Step 3: Cài đặt**

Thay toàn bộ `packages/contracts/src/events.ts`:
```ts
import type { FromSchema } from 'json-schema-to-ts';

/** Trường chung của mọi event: quy ước event của ecommerce (JSON phẳng, không envelope). */
const commonProperties = {
  eventId: { type: 'string', format: 'uuid' },
  occurredAtUtc: { type: 'string', format: 'date-time' },
  tenantId: { type: 'string', minLength: 1 },
  correlationId: { type: 'string', minLength: 1 },
} as const;

const moneyProperties = {
  amount: {
    type: 'integer',
    minimum: 1,
    description: 'Số nguyên minor unit (VND: đồng, USD: cent)',
  },
  currency: { type: 'string', enum: ['VND', 'USD'] },
} as const;

export const orderReadyForPaymentV1 = {
  $id: 'urn:billing:schema:OrderReadyForPayment:v1',
  type: 'object',
  required: [
    'eventId',
    'occurredAtUtc',
    'tenantId',
    'correlationId',
    'orderId',
    'customerId',
    'amount',
    'currency',
  ],
  properties: {
    ...commonProperties,
    orderId: { type: 'string', format: 'uuid' },
    customerId: { type: 'string', minLength: 1 },
    ...moneyProperties,
  },
} as const;

export const orderPaidV1 = {
  $id: 'urn:billing:schema:OrderPaid:v1',
  type: 'object',
  required: [
    'eventId',
    'occurredAtUtc',
    'tenantId',
    'correlationId',
    'orderId',
    'walletTransactionId',
    'amount',
    'currency',
    'paidAtUtc',
  ],
  properties: {
    ...commonProperties,
    orderId: { type: 'string', format: 'uuid' },
    walletTransactionId: { type: 'string', minLength: 1 },
    ...moneyProperties,
    paidAtUtc: { type: 'string', format: 'date-time' },
  },
} as const;

export const orderPaymentFailedV1 = {
  $id: 'urn:billing:schema:OrderPaymentFailed:v1',
  type: 'object',
  required: ['eventId', 'occurredAtUtc', 'tenantId', 'correlationId', 'orderId', 'reason'],
  properties: {
    ...commonProperties,
    orderId: { type: 'string', format: 'uuid' },
    reason: {
      type: 'string',
      enum: ['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'],
    },
  },
} as const;

/** Mỗi event: schema, routing key (khóa định tuyến trên exchange) và tên file schema phát hành. */
export const eventCatalog = {
  OrderReadyForPaymentV1: {
    schema: orderReadyForPaymentV1,
    routingKey: 'order-ready-for-payment.v1',
    schemaFile: 'OrderReadyForPayment.v1.schema.json',
  },
  OrderPaidV1: {
    schema: orderPaidV1,
    routingKey: 'order-paid.v1',
    schemaFile: 'OrderPaid.v1.schema.json',
  },
  OrderPaymentFailedV1: {
    schema: orderPaymentFailedV1,
    routingKey: 'order-payment-failed.v1',
    schemaFile: 'OrderPaymentFailed.v1.schema.json',
  },
} as const;

export type EventName = keyof typeof eventCatalog;

export type OrderReadyForPaymentV1 = FromSchema<typeof orderReadyForPaymentV1>;
export type OrderPaidV1 = FromSchema<typeof orderPaidV1>;
export type OrderPaymentFailedV1 = FromSchema<typeof orderPaymentFailedV1>;

export interface EventPayloads {
  OrderReadyForPaymentV1: OrderReadyForPaymentV1;
  OrderPaidV1: OrderPaidV1;
  OrderPaymentFailedV1: OrderPaymentFailedV1;
}
```

Thay toàn bộ `packages/contracts/src/validate.ts`:
```ts
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { ajv } from './ajv.js';
import { eventCatalog, type EventName, type EventPayloads } from './events.js';

const validators = new Map<EventName, ValidateFunction>(
  (Object.keys(eventCatalog) as EventName[]).map((name) => [
    name,
    ajv.compile(eventCatalog[name].schema),
  ]),
);

export type ValidationResult<T> = { ok: true; event: T } | { ok: false; errors: string[] };

/** Kiểm tra một event đã parse theo schema của nó; trường lạ được bỏ qua (tolerant reader). */
export function validateEvent<N extends EventName>(
  name: N,
  raw: unknown,
): ValidationResult<EventPayloads[N]> {
  const validate = validators.get(name);
  if (!validate) return { ok: false, errors: [`UNKNOWN_EVENT ${name}`] };
  if (!validate(raw)) {
    return {
      ok: false,
      errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`),
    };
  }
  // Đã khớp schema ở trên; kiểu ajv suy ra không tương thích với EventPayloads nên đi qua unknown.
  return { ok: true, event: raw as unknown as EventPayloads[N] };
}
```

Thay `packages/contracts/src/emit.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eventCatalog } from './events.js';
import { chargeWebhookSchema } from './webhook.js';

/** Ghi JSON Schema thành file để các bên (kể cả team ecommerce, C#) lấy làm hợp đồng. */
export async function emitSchemas(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: Array<[string, unknown]> = [
    ['payment.charge-event.v1.json', chargeWebhookSchema],
    ...Object.values(eventCatalog).map((entry): [string, unknown] => [
      entry.schemaFile,
      entry.schema,
    ]),
  ];
  const written: string[] = [];
  for (const [name, schema] of files) {
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    written.push(path);
  }
  return written;
}
```

Thay `packages/contracts/src/index.ts`:
```ts
export {
  eventCatalog,
  orderPaidV1,
  orderPaymentFailedV1,
  orderReadyForPaymentV1,
} from './events.js';
export type {
  EventName,
  EventPayloads,
  OrderPaidV1,
  OrderPaymentFailedV1,
  OrderReadyForPaymentV1,
} from './events.js';
export { validateEvent } from './validate.js';
export type { ValidationResult } from './validate.js';
export {
  DEFAULT_TOLERANCE_SECONDS,
  chargeWebhookSchema,
  signWebhook,
  validateChargeWebhook,
  verifyWebhook,
} from './webhook.js';
export type {
  ChargeWebhookPayload,
  ChargeWebhookResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './webhook.js';
export { emitSchemas } from './emit.js';
```

Xóa envelope: `git rm packages/contracts/src/envelope.ts`.

Trong `tools/boundaries.test.ts` đổi chuỗi mã trong ca "forbids domain from importing shared packages other than money": `"import { validateMessage } from '@billing/contracts';\nexport const y = validateMessage;\n"` thành `"import { validateEvent } from '@billing/contracts';\nexport const y = validateEvent;\n"` (ý nghĩa test không đổi).

- [ ] **Step 4: Tài liệu**

`docs/adr/0008-flat-event-contracts.vi.md`:
```markdown
# ADR-0008: Event JSON phẳng theo quy ước của ecommerce, bỏ envelope chung

**Trạng thái:** Chấp nhận — 2026-10-10. Thay thế phần "envelope" của ADR-0001 (phần "JSON thuần, không bám MassTransit" vẫn giữ).

## Bối cảnh

Spec nền tảng định nghĩa một envelope chung (`messageId`, `type`, `occurredAt`, `causationId`, `data`). Khi làm Bước 4,
ecommerce đã có event thật (`OrderPlacedV1`) theo quy ước khác: JSON phẳng, `eventId`/`occurredAtUtc`/`tenantId`/
`correlationId` cùng các trường nghiệp vụ, version trong tên, schema bất biến sau khi phát hành (`shared/EventContracts`).

## Quyết định

Mọi event của luồng order dùng JSON phẳng như quy ước của ecommerce, cho cả `orders.events` lẫn `billing.events`:
`OrderReadyForPaymentV1`, `OrderPaidV1`, `OrderPaymentFailedV1`. Version nằm trong tên event và routing key
(`order-paid.v1`). `amount` là số nguyên minor unit kèm `currency` (khác `total decimal` của ecommerce; adapter bên đó đổi).
Người nhận theo "tolerant reader". Schema nằm ở `packages/contracts` và được emit thành `{Event}.v{N}.schema.json`.

## Phương án đã loại

Giữ envelope của billing: có `causationId` và `type` tường minh, nhưng buộc ecommerce thêm một lớp bọc khác với các event họ đang phát.

## Hệ quả

Hai bên dùng cùng một kiểu event; không có `causationId` (chuỗi nguyên nhân dựa vào `correlationId` và `eventId`).
`validateMessage`/`Envelope` bị xóa khỏi `@billing/contracts`; thay bằng `validateEvent(name, raw)`.
```

Trong `docs/adr/0001-json-contract-over-masstransit.vi.md` thêm ngay dưới dòng `**Trạng thái:** …`: `**Cập nhật 2026-10-10:** hình dạng message (envelope) được thay bằng ADR-0008; quyết định "JSON thuần, không bám MassTransit" vẫn đúng.`

Trong `docs/superpowers/specs/2026-10-09-billing-framework-design.md`, thay toàn bộ phần từ dòng `### Envelope chung (JSON thuần)` đến ngay trước dòng `### Nạp tiền (nội bộ billing)` bằng:
```markdown
### Hình dạng event (JSON phẳng, theo quy ước của ecommerce)

Mỗi event là một JSON phẳng như `OrderPlacedV1` của ecommerce: `eventId`, `occurredAtUtc`, `tenantId`, `correlationId` cùng
các trường nghiệp vụ; không có envelope (xem ADR-0008). Version nằm trong tên event (`OrderPaidV1`, schema
`OrderPaid.v1.schema.json`) và routing key (`order-paid.v1`). Thêm trường tùy chọn là tương thích; đổi nghĩa hoặc thêm
trường bắt buộc thì tạo `V2` chạy song song. Người nhận theo "tolerant reader". Chi tiết ở
`docs/superpowers/specs/2026-10-10-order-payment-integration-design.md`.

### Event luồng thanh toán order

| Event | Bên phát | Bên nhận | Ý nghĩa |
|---|---|---|---|
| `OrderReadyForPaymentV1` | orders | wallet | Order hoàn tất, cần thu tiền. Trường nghiệp vụ: `orderId`, `customerId`, `amount`, `currency` |
| `OrderPaidV1` | wallet | orders | Đã trừ tiền. `orderId`, `walletTransactionId`, `amount`, `currency`, `paidAtUtc` |
| `OrderPaymentFailedV1` | wallet | orders | Từ chối. `orderId`, `reason` (`INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`) |

```

- [ ] **Step 5: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run packages/contracts tools
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test
```
Expected: PASS. Nếu `format:check` lệch ở markdown mới, chạy `corepack pnpm exec prettier --write` đúng các file đó.

- [ ] **Step 6: Commit**

```bash
git add -A packages/contracts tools docs
git commit -m "feat(contracts): flat order payment events (OrderReadyForPayment/OrderPaid/OrderPaymentFailed), drop envelope"
```

---

### Task 2: `@billing/testing` — RabbitMQ dùng chung cho test tích hợp

**Files:**
- Modify: `packages/testing/package.json`, `packages/testing/src/provided-context.ts`, `packages/testing/src/index.ts`, `vitest.integration.config.ts`, `docs/architecture/README.md` (mục Kiểm thử)
- Rename: `packages/testing/src/sql-server.global-setup.ts` → `packages/testing/src/containers.global-setup.ts` (`git mv`)
- Create: `packages/testing/src/rabbitmq.ts`, `packages/testing/src/rabbitmq.integration.test.ts`

**Interfaces:**
- Consumes: không (độc lập).
- Produces (`@billing/testing`):
  - `interface BrokerAccess { host: string; port: number; vhost: string; user: string; password: string }`
  - `BILLING_VHOST_PERMISSIONS` (đúng hai bộ quyền ở Global Constraints), `BILLING_EXCHANGES = ['orders.events', 'billing.events']`
  - `createTestBroker(prefix?: string): Promise<TestBroker>`; `interface TestBroker { wallet: BrokerAccess; ecommerce: BrokerAccess; admin: BrokerAccess; closeConnections(options?: { timeoutMs?: number; user?: string }): Promise<number>; drop(): Promise<void> }` — mỗi lần gọi tạo một vhost ngẫu nhiên có hai exchange topic bền và hai user (`billing_wallet`, `ecommerce_orders`) với quyền đúng spec; `closeConnections` thăm dò management API đến khi thấy kết nối của vhost (số liệu trễ ~5 s; chỉ tính kết nối của `user` nếu có truyền, ví dụ `billing_wallet`) rồi xóa chúng, trả về số kết nối đã xóa (0 nếu hết `timeoutMs`, mặc định 15000)
  - context vitest `rabbitmq: { host: string; amqpPort: number; managementPort: number; adminUser: string; adminPassword: string }`

- [ ] **Step 1: Phụ thuộc**

```bash
corepack pnpm --filter @billing/testing add @testcontainers/rabbitmq@^12.2.0
```
Expected: không lỗi (cùng dòng phiên bản `^12.2.0` với `@testcontainers/mssqlserver`).

- [ ] **Step 2: Viết test thất bại**

`packages/testing/src/rabbitmq.integration.test.ts`:
```ts
import { afterAll, describe, expect, inject, it } from 'vitest';
import { BILLING_EXCHANGES, BILLING_VHOST_PERMISSIONS, createTestBroker, type TestBroker } from './rabbitmq.js';

const brokers: TestBroker[] = [];
afterAll(async () => {
  for (const broker of brokers) await broker.drop();
});

async function management<T>(path: string): Promise<{ status: number; body: T | null }> {
  const server = inject('rabbitmq');
  const response = await fetch(`http://${server.host}:${server.managementPort}/api/${path}`, {
    headers: {
      authorization: `Basic ${Buffer.from(`${server.adminUser}:${server.adminPassword}`).toString('base64')}`,
    },
  });
  return { status: response.status, body: response.ok ? ((await response.json()) as T) : null };
}

describe('createTestBroker', () => {
  it('creates an isolated vhost with both exchanges and the two service users', async () => {
    const broker = await createTestBroker('probe');
    brokers.push(broker);
    const vhost = encodeURIComponent(broker.wallet.vhost);

    expect((await management(`vhosts/${vhost}`)).status).toBe(200);
    const exchanges = (await management<Array<{ name: string; type: string; durable: boolean }>>(`exchanges/${vhost}`)).body ?? [];
    for (const name of BILLING_EXCHANGES) {
      expect(exchanges).toContainEqual(expect.objectContaining({ name, type: 'topic', durable: true }));
    }

    for (const [user, expected] of Object.entries(BILLING_VHOST_PERMISSIONS)) {
      const permission = await management<{ configure: string; write: string; read: string }>(`permissions/${vhost}/${user}`);
      expect(permission.body).toMatchObject(expected);
    }
    expect(broker.wallet).toMatchObject({ user: 'billing_wallet', vhost: broker.wallet.vhost });
    expect(broker.ecommerce).toMatchObject({ user: 'ecommerce_orders' });
    expect(broker.wallet.password).not.toBe('');
  });

  it('gives every call its own vhost', async () => {
    const a = await createTestBroker('probe');
    const b = await createTestBroker('probe');
    brokers.push(a, b);
    expect(a.wallet.vhost).not.toBe(b.wallet.vhost);
  });

  it('drops its vhost', async () => {
    const broker = await createTestBroker('probe');
    const vhost = encodeURIComponent(broker.wallet.vhost);
    await broker.drop();
    expect((await management(`vhosts/${vhost}`)).status).toBe(404);
  });

  it('closeConnections() returns 0 when nothing is connected', async () => {
    const broker = await createTestBroker('probe');
    brokers.push(broker);
    expect(await broker.closeConnections({ timeoutMs: 300 })).toBe(0);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration rabbitmq`
Expected: FAIL (không resolve được `./rabbitmq.js`).

- [ ] **Step 4: Cài đặt**

`git mv packages/testing/src/sql-server.global-setup.ts packages/testing/src/containers.global-setup.ts`, rồi thay nội dung bằng:
```ts
import { MSSQLServerContainer } from '@testcontainers/mssqlserver';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import type { TestProject } from 'vitest/node';
import './provided-context.js';

const SA_PASSWORD = 'Str0ng!Passw0rd';

/**
 * Khởi động SQL Server 2022 và RabbitMQ 3 song song, dùng chung cho cả lượt chạy integration. Mỗi test file tự tạo
 * DB riêng (`createTestDatabase`) hoặc vhost riêng (`createTestBroker`). RabbitMQ có thể khởi động chậm: timeout 120 s.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [sql, rabbit] = await Promise.allSettled([
    new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
      .acceptLicense()
      .withPassword(SA_PASSWORD)
      .start(),
    new RabbitMQContainer('rabbitmq:3-management-alpine').withStartupTimeout(120_000).start(),
  ]);

  const stopAll = async (): Promise<void> => {
    await Promise.allSettled([
      sql.status === 'fulfilled' ? sql.value.stop() : undefined,
      rabbit.status === 'fulfilled' ? rabbit.value.stop() : undefined,
    ]);
  };
  if (sql.status === 'rejected' || rabbit.status === 'rejected') {
    await stopAll();
    throw sql.status === 'rejected' ? sql.reason : (rabbit as PromiseRejectedResult).reason;
  }

  project.provide('sqlServer', {
    host: sql.value.getHost(),
    port: sql.value.getPort(),
    user: sql.value.getUsername(),
    password: sql.value.getPassword(),
  });
  project.provide('rabbitmq', {
    host: rabbit.value.getHost(),
    amqpPort: rabbit.value.getMappedPort(5672),
    managementPort: rabbit.value.getMappedPort(15672),
    adminUser: 'guest',
    adminPassword: 'guest',
  });

  return stopAll;
}
```

`packages/testing/src/provided-context.ts` (thêm kiểu và khai báo):
```ts
export interface SqlServerConnection {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface RabbitMqConnection {
  host: string;
  amqpPort: number;
  managementPort: number;
  adminUser: string;
  adminPassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    sqlServer: SqlServerConnection;
    rabbitmq: RabbitMqConnection;
  }
}
```

`packages/testing/package.json`: đổi export `"./sql-server.global-setup": "./src/sql-server.global-setup.ts"` thành `"./containers.global-setup": "./src/containers.global-setup.ts"`. `vitest.integration.config.ts`: đổi `globalSetup: ['./packages/testing/src/sql-server.global-setup.ts']` thành `['./packages/testing/src/containers.global-setup.ts']`. Chạy `git grep -n "sql-server.global-setup"` và sửa mọi tham chiếu còn lại (kể cả tài liệu).

`packages/testing/src/rabbitmq.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import './provided-context.js';

export interface BrokerAccess {
  host: string;
  port: number;
  vhost: string;
  user: string;
  password: string;
}

/** Nguyên văn bảng quyền của spec (mục 3); `deploy/scripts/init-rabbitmq.sh` phải khớp (có test kiểm tra). */
export const BILLING_VHOST_PERMISSIONS = {
  billing_wallet: {
    configure: '^wallet\\..*',
    write: '^(billing\\.events|wallet\\..*)$',
    read: '^(orders\\.events|wallet\\..*)$',
  },
  ecommerce_orders: {
    configure: '^ecommerce\\..*',
    write: '^(orders\\.events|ecommerce\\..*)$',
    read: '^(billing\\.events|ecommerce\\..*)$',
  },
} as const;

export const BILLING_EXCHANGES = ['orders.events', 'billing.events'] as const;

const TEST_PASSWORDS = {
  billing_wallet: 'wallet-test-password',
  ecommerce_orders: 'ecommerce-test-password',
} as const;

export interface TestBroker {
  wallet: BrokerAccess;
  ecommerce: BrokerAccess;
  admin: BrokerAccess;
  /** Xóa các kết nối của vhost này (của riêng `user` nếu có) để mô phỏng mất kết nối. Trả về số kết nối đã xóa. */
  closeConnections(options?: { timeoutMs?: number; user?: string }): Promise<number>;
  drop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

/** Tạo một vhost ngẫu nhiên giống môi trường thật: hai exchange topic, hai user với quyền theo spec. */
export async function createTestBroker(prefix = 'test'): Promise<TestBroker> {
  const server = inject('rabbitmq');
  const vhost = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const base = `http://${server.host}:${server.managementPort}/api`;
  const authorization = `Basic ${Buffer.from(`${server.adminUser}:${server.adminPassword}`).toString('base64')}`;

  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const response = await fetch(`${base}/${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new Error(`RabbitMQ management ${method} ${path} -> ${response.status} ${await response.text()}`);
    }
    return response;
  };

  await call('PUT', `vhosts/${enc(vhost)}`, {});
  await call('PUT', `permissions/${enc(vhost)}/${enc(server.adminUser)}`, { configure: '.*', write: '.*', read: '.*' });
  for (const [user, permissions] of Object.entries(BILLING_VHOST_PERMISSIONS)) {
    await call('PUT', `users/${user}`, { password: TEST_PASSWORDS[user as keyof typeof TEST_PASSWORDS], tags: '' });
    await call('PUT', `permissions/${enc(vhost)}/${user}`, permissions);
  }
  for (const name of BILLING_EXCHANGES) {
    await call('PUT', `exchanges/${enc(vhost)}/${enc(name)}`, { type: 'topic', durable: true });
  }

  const access = (user: string, password: string): BrokerAccess => ({
    host: server.host,
    port: server.amqpPort,
    vhost,
    user,
    password,
  });

  return {
    wallet: access('billing_wallet', TEST_PASSWORDS.billing_wallet),
    ecommerce: access('ecommerce_orders', TEST_PASSWORDS.ecommerce_orders),
    admin: access(server.adminUser, server.adminPassword),
    async closeConnections({ timeoutMs = 15_000, user } = {}) {
      // Management API chỉ liệt kê kết nối sau ~5 giây: thăm dò đến khi thấy.
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const listed = await call('GET', `vhosts/${enc(vhost)}/connections`);
        const connections = ((await listed.json()) as Array<{ name: string; user: string }>).filter(
          (connection) => user === undefined || connection.user === user,
        );
        if (connections.length > 0) {
          for (const connection of connections) await call('DELETE', `connections/${enc(connection.name)}`);
          return connections.length;
        }
        if (Date.now() >= deadline) return 0;
        await sleep(500);
      }
    },
    async drop() {
      await call('DELETE', `vhosts/${enc(vhost)}`);
    },
  };
}
```

`packages/testing/src/index.ts` thêm:
```ts
export { BILLING_EXCHANGES, BILLING_VHOST_PERMISSIONS, createTestBroker } from './rabbitmq.js';
export type { BrokerAccess, TestBroker } from './rabbitmq.js';
```

Trong `docs/architecture/README.md`, mục Kiểm thử, câu "Một container SQL Server dùng chung cho cả lượt chạy (`@billing/testing`), mỗi test file tự tạo database riêng bằng `createTestDatabase`." đổi thành: "Một container SQL Server và một container RabbitMQ dùng chung cho cả lượt chạy (`@billing/testing`); mỗi test file tự tạo database riêng bằng `createTestDatabase` hoặc vhost riêng bằng `createTestBroker`."

- [ ] **Step 5: Chạy test, lint, typecheck và toàn bộ integration**

```bash
corepack pnpm test:integration rabbitmq
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test:integration
```
Expected: PASS. Lần chạy đầu kéo image RabbitMQ; nếu container báo "Server startup complete not received", kiểm tra timeout 120 s đã áp dụng và dọn container rác (`docker ps -aq --filter ancestor=rabbitmq:3-management-alpine | xargs -r docker rm -f`).

- [ ] **Step 6: Commit**

```bash
git add -A packages/testing vitest.integration.config.ts docs pnpm-lock.yaml
git commit -m "feat(testing): shared RabbitMQ container and createTestBroker (vhost per test file)"
```

---

### Task 3: `@billing/messaging` — topology, publisher có confirm, consumer có retry/DLQ, kết nối tự phục hồi

**Files:**
- Create: `packages/messaging/package.json`, `src/index.ts`, `src/types.ts`, `src/topology.ts`, `src/publisher.ts`, `src/consumer.ts`, `src/client.ts`, `src/test-helpers.ts` (chỉ dùng trong test)
- Test: `src/topology.test.ts` (unit), `src/topology.integration.test.ts`, `src/publisher.integration.test.ts`, `src/consumer.integration.test.ts`, `src/client.integration.test.ts`

**Interfaces:**
- Consumes: `createTestBroker`, `waitFor`, `BrokerAccess` từ `@billing/testing` (Task 2).
- Produces (`@billing/messaging`):
  - `interface BrokerConfig { host: string; port: number; vhost: string; user: string; password: string }` (cấu trúc giống `BrokerAccess`), `interface BrokerLogger { info/warn/error(details: object, message?: string): void }`
  - `interface OutgoingMessage { exchange; routingKey; messageId; type; correlationId; body: string }` (`body` là JSON đã serialize), `type PublishResult = { kind: 'delivered' } | { kind: 'unroutable' } | { kind: 'failed'; error: string }`
  - `interface IncomingMessage { body: Buffer; messageId: string | undefined; type: string | undefined; redelivered: boolean; retryCount: number; headers: Record<string, unknown> }`; `type HandlerResult = { action: 'ack' } | { action: 'retry'; reason: string } | { action: 'reject'; reason: string }`; `type MessageHandler = (m: IncomingMessage) => Promise<HandlerResult>`
  - `interface ConsumerTopology { queue; workExchange; workRoutingKey; retryExchange; retryDelaysSeconds: readonly number[]; bindings: ReadonlyArray<{ exchange: string; routingKey: string }> }`; `declareConsumerTopology(channel, topology): Promise<void>` (idempotent; **passive-check** các exchange nguồn trong `bindings` — thiếu thì channel bị broker đóng với 404, nên phải gọi trên channel riêng dùng một lần); `retryQueueName(queue, seconds)` = `<queue>.retry.<giây>`, `retryRoutingKey(seconds)` = `retry.<giây>`, `deadLetterQueueName(queue)` = `<queue>.dlq`, `DLQ_ROUTING_KEY = 'dlq'`
  - `class ConfirmPublisher`: `publish(message: OutgoingMessage, headers?: Record<string, unknown>): Promise<PublishResult>` — luôn `mandatory` + `persistent`; **không bao giờ ném**; `NO_ROUTE` → `unroutable`; nack/mất kết nối/quá 10 s → `failed`
  - `class BrokerClient`: `static connect({ config, log, initialMaxRetries? }): Promise<BrokerClient>` (kết nối có `recovery` của amqplib; lỗi kết nối ban đầu sau `initialMaxRetries` (mặc định 5) lần thì ném); `readonly publisher: ConfirmPublisher`; `consume(spec: ConsumerSpec): Promise<void>` (khai báo topology trên channel riêng rồi bật consumer; tự bật lại sau mỗi lần kết nối lại; ném nếu topology lỗi); `stopConsuming(): Promise<void>` (hủy consumer và **chờ các handler đang chạy xong**); `close(): Promise<void>` (gọi `stopConsuming` rồi đóng kết nối)
  - `interface ConsumerSpec { topology: ConsumerTopology; prefetch: number; handler: MessageHandler }`
  - Hành vi consumer: `ack` → ack; `retry` → publish sang `retryExchange` key `retry.<delays[retryCount]>` với header `x-retry-count = retryCount + 1` và `x-last-error`, **chờ confirm** rồi mới ack bản gốc; hết bậc → `dlq`; `reject` → `dlq` ngay với header `x-dead-letter-reason`; handler ném lỗi → coi như `retry`; không republish được → `nack(requeue)`.

- [ ] **Step 1: Tạo package và phụ thuộc**

`packages/messaging/package.json`:
```json
{
  "name": "@billing/messaging",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}
```
```bash
corepack pnpm --filter @billing/messaging add amqplib@^2.2.0
corepack pnpm --filter @billing/messaging add -D @billing/testing@workspace:*
```
Expected: không lỗi; `pnpm-lock.yaml` có importer `packages/messaging`.

- [ ] **Step 2: Viết test thất bại**

`packages/messaging/src/topology.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  DLQ_ROUTING_KEY,
  deadLetterQueueName,
  declareConsumerTopology,
  retryQueueName,
  retryRoutingKey,
  type ConsumerTopology,
} from './topology.js';

const topology: ConsumerTopology = {
  queue: 'wallet.order-payments',
  workExchange: 'wallet.work',
  workRoutingKey: 'order-payments',
  retryExchange: 'wallet.retry',
  retryDelaysSeconds: [5, 30],
  bindings: [{ exchange: 'orders.events', routingKey: 'order-ready-for-payment.v1' }],
};

describe('topology names', () => {
  it('derives queue and routing key names', () => {
    expect(retryQueueName('wallet.order-payments', 30)).toBe('wallet.order-payments.retry.30');
    expect(retryRoutingKey(30)).toBe('retry.30');
    expect(deadLetterQueueName('wallet.order-payments')).toBe('wallet.order-payments.dlq');
    expect(DLQ_ROUTING_KEY).toBe('dlq');
  });
});

describe('declareConsumerTopology', () => {
  it('declares work/retry exchanges, queues with TTL dead-lettering to the work exchange, and never touches the default exchange', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return { queue: '', messageCount: 0, consumerCount: 0 };
      };
    const channel = {
      checkExchange: record('checkExchange'),
      assertExchange: record('assertExchange'),
      assertQueue: record('assertQueue'),
      bindQueue: record('bindQueue'),
    };

    await declareConsumerTopology(channel as never, topology);

    expect(calls).toEqual([
      ['checkExchange', 'orders.events'],
      ['assertExchange', 'wallet.work', 'direct', { durable: true }],
      ['assertExchange', 'wallet.retry', 'direct', { durable: true }],
      ['assertQueue', 'wallet.order-payments', { durable: true }],
      ['bindQueue', 'wallet.order-payments', 'wallet.work', 'order-payments'],
      ['bindQueue', 'wallet.order-payments', 'orders.events', 'order-ready-for-payment.v1'],
      [
        'assertQueue',
        'wallet.order-payments.retry.5',
        {
          durable: true,
          arguments: {
            'x-message-ttl': 5000,
            'x-dead-letter-exchange': 'wallet.work',
            'x-dead-letter-routing-key': 'order-payments',
          },
        },
      ],
      ['bindQueue', 'wallet.order-payments.retry.5', 'wallet.retry', 'retry.5'],
      [
        'assertQueue',
        'wallet.order-payments.retry.30',
        {
          durable: true,
          arguments: {
            'x-message-ttl': 30000,
            'x-dead-letter-exchange': 'wallet.work',
            'x-dead-letter-routing-key': 'order-payments',
          },
        },
      ],
      ['bindQueue', 'wallet.order-payments.retry.30', 'wallet.retry', 'retry.30'],
      ['assertQueue', 'wallet.order-payments.dlq', { durable: true }],
      ['bindQueue', 'wallet.order-payments.dlq', 'wallet.retry', 'dlq'],
    ]);
    expect(JSON.stringify(calls)).not.toContain('amq.default');
    expect(calls.some(([, , exchange]) => exchange === '')).toBe(false);
  });
});
```

`packages/messaging/src/test-helpers.ts`:
```ts
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { BrokerAccess } from '@billing/testing';
import type { ConsumerTopology } from './topology.js';
import type { BrokerLogger } from './types.js';

export const silentLog: BrokerLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Topology dùng trong test: giống wallet nhưng bậc retry ngắn. */
export const testTopology = (retryDelaysSeconds: readonly number[] = [1, 2]): ConsumerTopology => ({
  queue: 'wallet.test-queue',
  workExchange: 'wallet.work',
  workRoutingKey: 'test',
  retryExchange: 'wallet.retry',
  retryDelaysSeconds,
  bindings: [{ exchange: 'orders.events', routingKey: 'order-ready-for-payment.v1' }],
});

export function open(access: BrokerAccess): Promise<ChannelModel> {
  return amqp.connect({
    protocol: 'amqp',
    hostname: access.host,
    port: access.port,
    username: access.user,
    password: access.password,
    vhost: access.vhost,
  });
}

/** Đóng vai ecommerce: publish vào orders.events bằng đúng user ecommerce_orders. */
export async function publishAsOrders(
  channel: ConfirmChannel,
  body: unknown,
  options: { messageId: string; routingKey?: string } = { messageId: 'e1' },
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    channel.publish(
      'orders.events',
      options.routingKey ?? 'order-ready-for-payment.v1',
      Buffer.from(JSON.stringify(body)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: options.messageId,
        type: 'OrderReadyForPaymentV1',
        headers: { 'x-correlation-id': 'corr-1' },
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
```

`packages/messaging/src/topology.integration.test.ts`:
```ts
import { createTestBroker, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { open, testTopology } from './test-helpers.js';
import { declareConsumerTopology, deadLetterQueueName, retryQueueName } from './topology.js';

let broker: TestBroker;
beforeAll(async () => {
  broker = await createTestBroker('topo');
});
afterAll(async () => {
  await broker.drop();
});

describe('declareConsumerTopology (real broker, restricted wallet user)', () => {
  it('declares everything with the least-privilege wallet account, and is idempotent', async () => {
    const topology = testTopology([1, 2]);
    for (let run = 0; run < 2; run++) {
      const connection = await open(broker.wallet);
      const channel = await connection.createChannel();
      await declareConsumerTopology(channel, topology);
      await channel.close();
      await connection.close();
    }
    const admin = await open(broker.admin);
    const channel = await admin.createChannel();
    for (const name of [
      topology.queue,
      retryQueueName(topology.queue, 1),
      retryQueueName(topology.queue, 2),
      deadLetterQueueName(topology.queue),
    ]) {
      await expect(channel.checkQueue(name)).resolves.toMatchObject({ queue: name });
    }
    await admin.close();
  });

  it('fails clearly when a source exchange was not provisioned by the init script', async () => {
    const connection = await open(broker.wallet);
    const channel = await connection.createChannel();
    channel.on('error', () => undefined);
    await expect(
      declareConsumerTopology(channel, {
        ...testTopology(),
        bindings: [{ exchange: 'orders.missing', routingKey: 'x' }],
      }),
    ).rejects.toThrow(/NOT_FOUND|404/);
    await connection.close().catch(() => undefined);
  });
});
```

`packages/messaging/src/publisher.integration.test.ts`:
```ts
import { createTestBroker, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerClient } from './client.js';
import { open, silentLog } from './test-helpers.js';
import type { OutgoingMessage } from './types.js';

let broker: TestBroker;
let client: BrokerClient;

const paid = (messageId: string): OutgoingMessage => ({
  exchange: 'billing.events',
  routingKey: 'order-paid.v1',
  messageId,
  type: 'OrderPaidV1',
  correlationId: 'corr-9',
  body: JSON.stringify({ orderId: 'o1' }),
});

beforeAll(async () => {
  broker = await createTestBroker('pub');
  client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
});
afterAll(async () => {
  await client.close();
  await broker.drop();
});

describe('ConfirmPublisher', () => {
  it('reports unroutable when no queue is bound (the broker still confirms such messages)', async () => {
    expect(await client.publisher.publish(paid('m-unroutable'))).toEqual({ kind: 'unroutable' });
  });

  it('delivers with type, messageId, content type and correlation header once a consumer queue is bound', async () => {
    const ecommerce = await open(broker.ecommerce);
    const channel = await ecommerce.createChannel();
    await channel.assertQueue('ecommerce.results', { durable: true });
    await channel.bindQueue('ecommerce.results', 'billing.events', 'order-paid.v1');

    expect(await client.publisher.publish(paid('m-1'))).toEqual({ kind: 'delivered' });

    const message = await channel.get('ecommerce.results', { noAck: true });
    expect(message).not.toBe(false);
    if (message === false) return;
    expect(JSON.parse(message.content.toString())).toEqual({ orderId: 'o1' });
    expect(message.properties).toMatchObject({
      messageId: 'm-1',
      type: 'OrderPaidV1',
      contentType: 'application/json',
      deliveryMode: 2,
    });
    expect(message.properties.headers?.['x-correlation-id']).toBe('corr-9');
    await ecommerce.close();
  });

  it('fails (never throws) after the client is closed', async () => {
    const other = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    await other.close();
    const result = await other.publisher.publish(paid('m-closed'));
    expect(result.kind).toBe('failed');
  });

  it('settles many concurrent publishes independently', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => client.publisher.publish(paid(`m-c${i}`))));
    expect(results.every((r) => r.kind === 'delivered')).toBe(true);
  });
});
```
(Ca cuối dùng queue `ecommerce.results` đã được tạo ở ca trước; thứ tự ca trong file là có chủ đích.)

`packages/messaging/src/consumer.integration.test.ts`:
```ts
import { createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import type { ConfirmChannel } from 'amqplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BrokerClient } from './client.js';
import { open, publishAsOrders, silentLog, testTopology } from './test-helpers.js';
import { deadLetterQueueName } from './topology.js';
import type { HandlerResult, IncomingMessage } from './types.js';

let broker: TestBroker;
let client: BrokerClient;
let ordersChannel: ConfirmChannel;
let closeOrders: () => Promise<void>;

const topology = (delays: readonly number[]) => ({ ...testTopology(delays), queue: `wallet.q${Math.random().toString(36).slice(2, 8)}` });

beforeAll(async () => {
  broker = await createTestBroker('cons');
  const orders = await open(broker.ecommerce);
  ordersChannel = await orders.createConfirmChannel();
  closeOrders = () => orders.close();
});
afterAll(async () => {
  await closeOrders();
  await broker.drop();
});
beforeEach(async () => {
  client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
});
afterEach(async () => {
  await client.close();
});

async function queueDepth(name: string): Promise<number> {
  const admin = await open(broker.admin);
  const channel = await admin.createChannel();
  const { messageCount } = await channel.checkQueue(name);
  await admin.close();
  return messageCount;
}

describe('consumer', () => {
  it('acks a handled message and hands the handler the body, ids and retry count', async () => {
    const t = topology([1]);
    const seen: IncomingMessage[] = [];
    await client.consume({ topology: t, prefetch: 2, handler: async (m) => { seen.push(m); return { action: 'ack' }; } });
    await publishAsOrders(ordersChannel, { orderId: 'o1' }, { messageId: 'evt-1' });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ messageId: 'evt-1', type: 'OrderReadyForPaymentV1', redelivered: false, retryCount: 0 });
    expect(JSON.parse(seen[0]?.body.toString() ?? '')).toEqual({ orderId: 'o1' });
    await waitFor(async () => (await queueDepth(t.queue)) === 0);
  });

  it('retries through the TTL tiers with an increasing x-retry-count, then succeeds', async () => {
    const t = topology([1, 2]);
    const timeline: Array<{ count: number; at: number }> = [];
    const started = Date.now();
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async (m): Promise<HandlerResult> => {
        timeline.push({ count: m.retryCount, at: Date.now() - started });
        return m.retryCount < 2 ? { action: 'retry', reason: 'db down' } : { action: 'ack' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o2' }, { messageId: 'evt-2' });
    await waitFor(() => timeline.length === 3, { timeoutMs: 15_000 });
    expect(timeline.map((x) => x.count)).toEqual([0, 1, 2]);
    expect(timeline[1]!.at - timeline[0]!.at).toBeGreaterThanOrEqual(800);
    expect(timeline[2]!.at - timeline[1]!.at).toBeGreaterThanOrEqual(1800);
  });

  it('dead-letters once the tiers are exhausted and keeps the last error', async () => {
    const t = topology([1]);
    let calls = 0;
    await client.consume({ topology: t, prefetch: 1, handler: async () => { calls += 1; return { action: 'retry', reason: 'still broken' }; } });
    await publishAsOrders(ordersChannel, { orderId: 'o3' }, { messageId: 'evt-3' });
    await waitFor(async () => (await queueDepth(deadLetterQueueName(t.queue))) === 1, { timeoutMs: 15_000 });
    expect(calls).toBe(2);
    const admin = await open(broker.admin);
    const channel = await admin.createChannel();
    const dead = await channel.get(deadLetterQueueName(t.queue), { noAck: true });
    expect(dead).not.toBe(false);
    if (dead !== false) {
      expect(dead.properties.messageId).toBe('evt-3');
      expect(String(dead.properties.headers?.['x-dead-letter-reason'])).toContain('still broken');
      expect(JSON.parse(dead.content.toString())).toEqual({ orderId: 'o3' });
    }
    await admin.close();
    expect(await queueDepth(t.queue)).toBe(0);
  });

  it('rejects straight to the DLQ without retrying', async () => {
    const t = topology([1]);
    let calls = 0;
    await client.consume({ topology: t, prefetch: 1, handler: async () => { calls += 1; return { action: 'reject', reason: 'schema invalid' }; } });
    await publishAsOrders(ordersChannel, { nope: true }, { messageId: 'evt-4' });
    await waitFor(async () => (await queueDepth(deadLetterQueueName(t.queue))) === 1, { timeoutMs: 15_000 });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(calls).toBe(1);
  });

  it('treats a throwing handler as a retry', async () => {
    const t = topology([1]);
    const counts: number[] = [];
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async (m) => {
        counts.push(m.retryCount);
        if (m.retryCount === 0) throw new Error('boom');
        return { action: 'ack' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o5' }, { messageId: 'evt-5' });
    await waitFor(() => counts.length === 2, { timeoutMs: 15_000 });
    expect(counts).toEqual([0, 1]);
  });

  it('never runs more handlers at once than the prefetch', async () => {
    const t = topology([1]);
    let active = 0;
    let peak = 0;
    let finished = 0;
    await client.consume({
      topology: t,
      prefetch: 2,
      handler: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 150));
        active -= 1;
        finished += 1;
        return { action: 'ack' };
      },
    });
    for (let i = 0; i < 6; i++) await publishAsOrders(ordersChannel, { i }, { messageId: `evt-p${i}` });
    await waitFor(() => finished === 6, { timeoutMs: 15_000 });
    expect(peak).toBe(2);
  });

  it('stopConsuming() waits for the handler that is still running and acks it', async () => {
    const t = topology([1]);
    let release: () => void = () => undefined;
    let started = false;
    let done = false;
    await client.consume({
      topology: t,
      prefetch: 1,
      handler: async () => {
        started = true;
        await new Promise<void>((resolve) => (release = resolve));
        done = true;
        return { action: 'ack' };
      },
    });
    await publishAsOrders(ordersChannel, { orderId: 'o7' }, { messageId: 'evt-7' });
    await waitFor(() => started);

    let stopped = false;
    const stopping = client.stopConsuming().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(done).toBe(true);
    await waitFor(async () => (await queueDepth(t.queue)) === 0);
  });
});
```

`packages/messaging/src/client.integration.test.ts`:
```ts
import { createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrokerClient } from './client.js';
import { open, publishAsOrders, silentLog, testTopology } from './test-helpers.js';
import type { IncomingMessage } from './types.js';

let broker: TestBroker;

beforeAll(async () => {
  broker = await createTestBroker('client');
  const orders = await open(broker.ecommerce);
  const channel = await orders.createChannel();
  await channel.assertQueue('ecommerce.results', { durable: true });
  await channel.bindQueue('ecommerce.results', 'billing.events', 'order-paid.v1');
  await orders.close();
});
afterAll(async () => {
  await broker.drop();
});

/** Mỗi lần dùng mở kết nối ecommerce mới: `closeConnections` xóa MỌI kết nối của vhost, kể cả của bên đóng vai ecommerce. */
async function publishFromOrders(body: unknown, messageId: string): Promise<void> {
  const orders = await open(broker.ecommerce);
  try {
    const channel = await orders.createConfirmChannel();
    await publishAsOrders(channel, body, { messageId });
  } finally {
    await orders.close().catch(() => undefined);
  }
}

describe('BrokerClient recovery', () => {
  it('keeps consuming and publishing after the broker drops every connection', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const topology = { ...testTopology([1]), queue: 'wallet.recovery' };
    const handled: string[] = [];
    await client.consume({
      topology,
      prefetch: 2,
      handler: async (m) => {
        handled.push(m.messageId ?? '');
        return { action: 'ack' };
      },
    });

    await publishFromOrders({ n: 1 }, 'before');
    await waitFor(() => handled.includes('before'));

    expect(await broker.closeConnections()).toBeGreaterThan(0);

    // Sau khi kết nối lại: consumer nhận tiếp (thử publish đến khi thấy) và publisher publish được.
    let attempt = 0;
    await waitFor(
      async () => {
        await publishFromOrders({ n: 2 }, `after-${attempt++}`).catch(() => undefined);
        return handled.some((id) => id.startsWith('after-'));
      },
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    await waitFor(
      async () =>
        (
          await client.publisher.publish({
            exchange: 'billing.events',
            routingKey: 'order-paid.v1',
            messageId: 'recovered-publish',
            type: 'OrderPaidV1',
            correlationId: 'c',
            body: '{}',
          })
        ).kind === 'delivered',
      { timeoutMs: 30_000, intervalMs: 500 },
    );

    await client.close();
  });

  it('redelivers a message whose handler never acknowledged before the connection died', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    const topology = { ...testTopology([1]), queue: 'wallet.redelivery' };
    const deliveries: IncomingMessage[] = [];
    await client.consume({
      topology,
      prefetch: 1,
      handler: async (m) => {
        deliveries.push(m);
        if (deliveries.length === 1) return new Promise<never>(() => undefined);
        return { action: 'ack' };
      },
    });
    await publishFromOrders({ orderId: 'o-redeliver' }, 'evt-redeliver');
    await waitFor(() => deliveries.length === 1);

    expect(await broker.closeConnections()).toBeGreaterThan(0);

    await waitFor(() => deliveries.length >= 2, { timeoutMs: 30_000 });
    expect(deliveries[1]).toMatchObject({ messageId: 'evt-redeliver', redelivered: true });
    await client.close();
  });

  it('fails fast at startup when the broker cannot be reached', async () => {
    await expect(
      BrokerClient.connect({
        config: { ...broker.wallet, port: 1 },
        log: silentLog,
        initialMaxRetries: 1,
      }),
    ).rejects.toThrow();
  });

  it('fails startup with a clear error when a source exchange is missing', async () => {
    const client = await BrokerClient.connect({ config: broker.wallet, log: silentLog });
    await expect(
      client.consume({
        topology: {
          ...testTopology(),
          queue: 'wallet.bad',
          bindings: [{ exchange: 'orders.missing', routingKey: 'x' }],
        },
        prefetch: 1,
        handler: async () => ({ action: 'ack' }),
      }),
    ).rejects.toThrow(/NOT_FOUND|404/);
    await client.close();
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/messaging/src/topology.test.ts` rồi `corepack pnpm test:integration messaging`
Expected: FAIL (các module chưa tồn tại).

- [ ] **Step 4: Cài đặt**

`packages/messaging/src/types.ts`:
```ts
export interface BrokerConfig {
  host: string;
  port: number;
  vhost: string;
  user: string;
  password: string;
}

export interface BrokerLogger {
  info(details: object, message?: string): void;
  warn(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

export interface OutgoingMessage {
  exchange: string;
  routingKey: string;
  messageId: string;
  /** Tên event, ví dụ `OrderPaidV1` (thuộc tính AMQP `type`). */
  type: string;
  correlationId: string;
  /** JSON đã serialize. */
  body: string;
}

export type PublishResult =
  | { kind: 'delivered' }
  | { kind: 'unroutable' }
  | { kind: 'failed'; error: string };

export interface IncomingMessage {
  body: Buffer;
  messageId: string | undefined;
  type: string | undefined;
  redelivered: boolean;
  /** Số lần đã retry qua các bậc backoff (header `x-retry-count`). */
  retryCount: number;
  headers: Record<string, unknown>;
}

export type HandlerResult =
  | { action: 'ack' }
  | { action: 'retry'; reason: string }
  | { action: 'reject'; reason: string };

export type MessageHandler = (message: IncomingMessage) => Promise<HandlerResult>;
```

`packages/messaging/src/topology.ts`:
```ts
import type { Channel } from 'amqplib';

export interface ConsumerTopology {
  queue: string;
  workExchange: string;
  workRoutingKey: string;
  retryExchange: string;
  retryDelaysSeconds: readonly number[];
  bindings: ReadonlyArray<{ exchange: string; routingKey: string }>;
}

export const DLQ_ROUTING_KEY = 'dlq';

export const retryQueueName = (queue: string, seconds: number): string => `${queue}.retry.${seconds}`;
export const retryRoutingKey = (seconds: number): string => `retry.${seconds}`;
export const deadLetterQueueName = (queue: string): string => `${queue}.dlq`;

/**
 * Khai báo idempotent: exchange `work`/`retry` (direct), queue chính, các queue retry (TTL, dead-letter về `work`) và DLQ.
 * Exchange nguồn trong `bindings` chỉ được kiểm tra (passive) vì do script init tạo; nếu thiếu, broker đóng channel
 * với 404 — nên chạy hàm này trên một channel dùng một lần. Không bao giờ dùng default exchange (`amq.default`).
 */
export async function declareConsumerTopology(channel: Channel, topology: ConsumerTopology): Promise<void> {
  for (const exchange of new Set(topology.bindings.map((binding) => binding.exchange))) {
    await channel.checkExchange(exchange);
  }
  await channel.assertExchange(topology.workExchange, 'direct', { durable: true });
  await channel.assertExchange(topology.retryExchange, 'direct', { durable: true });

  await channel.assertQueue(topology.queue, { durable: true });
  await channel.bindQueue(topology.queue, topology.workExchange, topology.workRoutingKey);
  for (const binding of topology.bindings) {
    await channel.bindQueue(topology.queue, binding.exchange, binding.routingKey);
  }

  for (const seconds of topology.retryDelaysSeconds) {
    const name = retryQueueName(topology.queue, seconds);
    await channel.assertQueue(name, {
      durable: true,
      arguments: {
        'x-message-ttl': seconds * 1000,
        'x-dead-letter-exchange': topology.workExchange,
        'x-dead-letter-routing-key': topology.workRoutingKey,
      },
    });
    await channel.bindQueue(name, topology.retryExchange, retryRoutingKey(seconds));
  }

  const dead = deadLetterQueueName(topology.queue);
  await channel.assertQueue(dead, { durable: true });
  await channel.bindQueue(dead, topology.retryExchange, DLQ_ROUTING_KEY);
}
```

`packages/messaging/src/publisher.ts`:
```ts
import type { ConfirmChannel } from 'amqplib';
import type { OutgoingMessage, PublishResult } from './types.js';

const PUBLISH_TIMEOUT_MS = 10_000;

/**
 * Publish có confirm và `mandatory`. Broker vẫn confirm message không định tuyến được (và bỏ lặng lẽ nếu không
 * `mandatory`), nên ta lắng nghe `return` — gửi TRƯỚC confirm — để biết message không có nơi nhận.
 * Không bao giờ ném.
 */
export class ConfirmPublisher {
  readonly #returned = new Set<string>();
  #channel: ConfirmChannel | undefined;

  attach(channel: ConfirmChannel): void {
    this.#channel = channel;
    channel.on('return', (message) => {
      const id = message.properties.messageId;
      if (typeof id === 'string') this.#returned.add(id);
    });
  }

  detach(channel: ConfirmChannel): void {
    if (this.#channel === channel) this.#channel = undefined;
  }

  detachAll(): void {
    this.#channel = undefined;
  }

  publish(message: OutgoingMessage, headers: Record<string, unknown> = {}): Promise<PublishResult> {
    const channel = this.#channel;
    if (!channel) return Promise.resolve({ kind: 'failed', error: 'broker is not connected' });
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: PublishResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#returned.delete(message.messageId);
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ kind: 'failed', error: `no confirm within ${PUBLISH_TIMEOUT_MS} ms` }),
        PUBLISH_TIMEOUT_MS,
      );
      try {
        channel.publish(
          message.exchange,
          message.routingKey,
          Buffer.from(message.body, 'utf8'),
          {
            mandatory: true,
            persistent: true,
            contentType: 'application/json',
            messageId: message.messageId,
            type: message.type,
            headers: { ...headers, 'x-correlation-id': message.correlationId },
          },
          (error) => {
            if (error) {
              finish({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
            } else {
              finish(this.#returned.has(message.messageId) ? { kind: 'unroutable' } : { kind: 'delivered' });
            }
          },
        );
      } catch (error) {
        finish({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
      }
    });
  }
}
```

`packages/messaging/src/consumer.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { ConfirmPublisher } from './publisher.js';
import { DLQ_ROUTING_KEY, retryRoutingKey, type ConsumerTopology } from './topology.js';
import type { BrokerLogger, HandlerResult, IncomingMessage, MessageHandler } from './types.js';

export interface ConsumerSpec {
  topology: ConsumerTopology;
  prefetch: number;
  handler: MessageHandler;
}

export interface RunningConsumer {
  /** Hủy đăng ký rồi chờ mọi handler đang chạy xong (kể cả ack). */
  stop(): Promise<void>;
}

const RETRY_COUNT = 'x-retry-count';

/** Header do broker thêm khi dead-letter; không chép sang bản republish. */
const isBrokerHeader = (name: string): boolean =>
  name === 'x-death' || name.startsWith('x-first-death') || name.startsWith('x-last-death');

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function startConsumer(options: {
  channel: Channel;
  publisher: ConfirmPublisher;
  spec: ConsumerSpec;
  log: BrokerLogger;
}): Promise<RunningConsumer> {
  const { channel, publisher, spec, log } = options;
  const { topology } = spec;
  const inflight = new Set<Promise<void>>();

  const forward = async (raw: ConsumeMessage, routingKey: string, extra: Record<string, unknown>): Promise<void> => {
    const headers = Object.fromEntries(
      Object.entries(raw.properties.headers ?? {}).filter(([name]) => !isBrokerHeader(name)),
    );
    const result = await publisher.publish(
      {
        exchange: topology.retryExchange,
        routingKey,
        messageId: raw.properties.messageId ?? randomUUID(),
        type: raw.properties.type ?? 'unknown',
        correlationId: String(raw.properties.headers?.['x-correlation-id'] ?? ''),
        body: raw.content.toString('utf8'),
      },
      { ...headers, ...extra },
    );
    if (result.kind !== 'delivered') {
      throw new Error(`could not forward message (${result.kind === 'failed' ? result.error : 'unroutable'})`);
    }
  };

  const deadLetter = async (raw: ConsumeMessage, reason: string): Promise<void> => {
    await forward(raw, DLQ_ROUTING_KEY, { 'x-dead-letter-reason': reason });
    channel.ack(raw);
  };

  const retry = async (raw: ConsumeMessage, retryCount: number, reason: string): Promise<void> => {
    const delay = topology.retryDelaysSeconds[retryCount];
    if (delay === undefined) {
      await deadLetter(raw, `retries exhausted: ${reason}`);
      return;
    }
    await forward(raw, retryRoutingKey(delay), { [RETRY_COUNT]: retryCount + 1, 'x-last-error': reason });
    channel.ack(raw);
  };

  const process = async (raw: ConsumeMessage): Promise<void> => {
    const rawCount = Number(raw.properties.headers?.[RETRY_COUNT] ?? 0);
    const retryCount = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
    const incoming: IncomingMessage = {
      body: raw.content,
      messageId: raw.properties.messageId,
      type: raw.properties.type,
      redelivered: raw.fields.redelivered,
      retryCount,
      headers: raw.properties.headers ?? {},
    };

    let result: HandlerResult;
    try {
      result = await spec.handler(incoming);
    } catch (error) {
      result = { action: 'retry', reason: `handler threw: ${errorText(error)}` };
    }

    try {
      if (result.action === 'ack') channel.ack(raw);
      else if (result.action === 'retry') await retry(raw, retryCount, result.reason);
      else await deadLetter(raw, result.reason);
    } catch (error) {
      // Kênh đã đóng hoặc không republish được: trả message về queue; nếu kênh chết thì broker tự giao lại.
      log.error({ err: errorText(error), messageId: raw.properties.messageId }, 'could not settle message; requeueing');
      try {
        channel.nack(raw, false, true);
      } catch {
        // Kênh đã chết: message sẽ được broker giao lại khi consumer kế tiếp kết nối.
      }
    }
  };

  await channel.prefetch(spec.prefetch);
  const { consumerTag } = await channel.consume(
    topology.queue,
    (raw) => {
      if (raw === null) return;
      const task: Promise<void> = process(raw).finally(() => {
        inflight.delete(task);
      });
      inflight.add(task);
    },
    { noAck: false },
  );

  return {
    async stop() {
      try {
        await channel.cancel(consumerTag);
      } catch {
        // Kênh đã đóng (mất kết nối): không còn gì để hủy.
      }
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
```

`packages/messaging/src/client.ts`:
```ts
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { startConsumer, type ConsumerSpec, type RunningConsumer } from './consumer.js';
import { ConfirmPublisher } from './publisher.js';
import { declareConsumerTopology } from './topology.js';
import type { BrokerConfig, BrokerLogger } from './types.js';

interface Registration {
  spec: ConsumerSpec;
  running: RunningConsumer | undefined;
}

/**
 * Một kết nối tự phục hồi: sau mỗi lần (kết nối lại) `setup` tạo lại confirm channel cho publisher, channel cho
 * consumer và bật lại mọi consumer đã đăng ký. Mất kết nối giữa chừng: message chưa ack được broker giao lại
 * (consumer nhận `redelivered = true`), còn publish trong lúc mất kết nối trả `failed` để bên gọi thử lại.
 */
export class BrokerClient {
  readonly publisher = new ConfirmPublisher();
  readonly #log: BrokerLogger;
  readonly #registrations: Registration[] = [];
  #model: { close(): Promise<void> } | undefined;
  #channelModel: ChannelModel | undefined;
  #consumeChannel: Channel | undefined;
  #closing = false;

  private constructor(log: BrokerLogger) {
    this.#log = log;
  }

  static async connect(options: {
    config: BrokerConfig;
    log: BrokerLogger;
    initialMaxRetries?: number;
  }): Promise<BrokerClient> {
    const client = new BrokerClient(options.log);
    const { config } = options;
    const model = await connect(
      {
        protocol: 'amqp',
        hostname: config.host,
        port: config.port,
        username: config.user,
        password: config.password,
        vhost: config.vhost,
      },
      {
        recovery: {
          initialDelay: 200,
          maxDelay: 5_000,
          initialMaxRetries: options.initialMaxRetries ?? 5,
          setup: (channelModel) => client.#setup(channelModel),
        },
      },
    );
    model.on('disconnect', (error) => {
      client.publisher.detachAll();
      client.#log.warn({ err: error.message }, 'broker connection lost; recovering');
    });
    model.on('error', (error) => client.#log.error({ err: error.message }, 'broker connection error'));
    client.#model = model;
    return client;
  }

  async consume(spec: ConsumerSpec): Promise<void> {
    const registration: Registration = { spec, running: undefined };
    this.#registrations.push(registration);
    if (this.#channelModel && this.#consumeChannel) {
      try {
        await this.#start(registration, this.#channelModel, this.#consumeChannel);
      } catch (error) {
        this.#registrations.splice(this.#registrations.indexOf(registration), 1);
        throw error;
      }
    }
  }

  async stopConsuming(): Promise<void> {
    this.#closing = true;
    for (const registration of this.#registrations) {
      await registration.running?.stop();
      registration.running = undefined;
    }
  }

  async close(): Promise<void> {
    await this.stopConsuming();
    this.publisher.detachAll();
    await this.#model?.close().catch(() => undefined);
  }

  async #setup(model: ChannelModel): Promise<void> {
    const publishChannel = await model.createConfirmChannel();
    publishChannel.on('error', (error) => this.#log.error({ err: error.message }, 'publish channel error'));
    publishChannel.on('close', () => this.publisher.detach(publishChannel));
    this.publisher.attach(publishChannel);

    const consumeChannel = await model.createChannel();
    consumeChannel.on('error', (error) => this.#log.error({ err: error.message }, 'consume channel error'));
    this.#channelModel = model;
    this.#consumeChannel = consumeChannel;

    if (this.#closing) return;
    for (const registration of this.#registrations) {
      await this.#start(registration, model, consumeChannel);
    }
  }

  async #start(registration: Registration, model: ChannelModel, consumeChannel: Channel): Promise<void> {
    // Kênh dùng một lần: nếu exchange nguồn thiếu, broker đóng nó (404) mà không ảnh hưởng consumer khác.
    const declaring = await model.createChannel();
    declaring.on('error', () => undefined);
    try {
      await declareConsumerTopology(declaring, registration.spec.topology);
    } finally {
      await declaring.close().catch(() => undefined);
    }
    registration.running = await startConsumer({
      channel: consumeChannel,
      publisher: this.publisher,
      spec: registration.spec,
      log: this.#log,
    });
    this.#log.info({ queue: registration.spec.topology.queue }, 'consumer started');
  }
}

```

`packages/messaging/src/index.ts`:
```ts
export { BrokerClient } from './client.js';
export { startConsumer } from './consumer.js';
export type { ConsumerSpec, RunningConsumer } from './consumer.js';
export { ConfirmPublisher } from './publisher.js';
export {
  DLQ_ROUTING_KEY,
  deadLetterQueueName,
  declareConsumerTopology,
  retryQueueName,
  retryRoutingKey,
} from './topology.js';
export type { ConsumerTopology } from './topology.js';
export type {
  BrokerConfig,
  BrokerLogger,
  HandlerResult,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  PublishResult,
} from './types.js';
```

- [ ] **Step 5: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run packages/messaging
corepack pnpm test:integration messaging
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS. Ghi chú để tránh đoán: (a) nếu `model.on('disconnect', …)` không phát khi xóa kết nối bằng management API, kiểm tra `recovery` đã được truyền (nếu không `connect` trả `ChannelModel` thường); (b) ca "keeps consuming and publishing after the broker drops every connection" cần ≥ ~5 giây vì `closeConnections` thăm dò management API, đó là bình thường; (c) nếu TypeScript phàn nàn `model.on('disconnect', …)` vì overload của `connect`, ép kiểu kết quả `as RecoveringChannelModel` (import type từ `amqplib`) tại đúng một chỗ và ghi vào báo cáo.

- [ ] **Step 6: Commit**

```bash
git add -A packages/messaging pnpm-lock.yaml
git commit -m "feat(messaging): amqplib client with recovery, confirm publisher (mandatory), retry/DLQ consumer"
```

---

### Task 4: Domain `ORDER_PAYMENT` và migration `003-orders`

**Files:**
- Modify: `services/wallet/src/domain/ledger-transaction.ts`, `domain/ledger-transaction.test.ts`, `infrastructure/kysely/migrations/index.ts`, `infrastructure/kysely/schema.ts`, `infrastructure/kysely/provisioning.integration.test.ts`
- Create: `infrastructure/kysely/migrations/003-orders.ts`, `infrastructure/kysely/orders-migration.integration.test.ts`

**Interfaces:**
- Consumes: `LedgerTransaction.create`, `InvalidLedgerTransactionError`, `Money` (Bước 3); `walletMigrations`, `provisionTenants`, `assertSchemaName`.
- Produces:
  - `type LedgerTransactionKind = 'TOPUP' | 'ORDER_PAYMENT'`; `LedgerTransaction.orderPayment(input: { id: string; orderId: string; walletAccountId: string; merchantAccountId: string; amount: Money; now: Date }): LedgerTransaction` — `businessKey = order:<orderId>`, kind `ORDER_PAYMENT`, dòng ví `−amount`, dòng merchant `+amount`; `amount` phải dương (nếu không → `InvalidLedgerTransactionError`)
  - `walletMigrations(schema)` có thêm khóa `'003-orders'` (sau `002-topups`)
  - Migration `003-orders` cho mỗi schema tenant: thay ràng buộc `ck_ledger_transactions_kind` bằng `check (kind in ('TOPUP', 'ORDER_PAYMENT'))`; bảng `order_payments(order_id nvarchar(64) PK, customer_id nvarchar(64) not null, wallet_transaction_id nvarchar(64) not null FK → ledger_transactions(id), amount bigint not null check > 0, currency nvarchar(3) not null check in ('VND','USD'), paid_at datetime2(3) not null)`; bảng `outbox(id nvarchar(64) PK, event_type nvarchar(64), routing_key nvarchar(100), payload nvarchar(max), correlation_id nvarchar(100), status nvarchar(8) check in ('PENDING','SENT'), attempts int, next_attempt_at datetime2(3), created_at datetime2(3), sent_at datetime2(3) null)` + index `ix_outbox_due (status, next_attempt_at, id)` (BẮT BUỘC cho `top (1) … updlock, readpast` của relay)
  - Kiểu bảng Kysely `OrderPaymentsTable`, `OutboxTable` và hai khóa `order_payments`, `outbox` trong `WalletDatabase`

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `services/wallet/src/domain/ledger-transaction.test.ts` (thêm import `Money` từ `@billing/money` và `InvalidLedgerTransactionError` từ `./errors.js` nếu file chưa có):
```ts
describe('LedgerTransaction.orderPayment', () => {
  const now = new Date('2026-10-10T10:00:00.000Z');
  const make = (amount = 50000, orderId = '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11') =>
    LedgerTransaction.orderPayment({
      id: 'tx_1',
      orderId,
      walletAccountId: 'wallet:c1',
      merchantAccountId: 'system:MERCHANT:VND',
      amount: Money.of(amount, 'VND'),
      now,
    });

  it('debits the wallet, credits the merchant, and is keyed by the order', () => {
    const p = make().toProps();
    expect(p.kind).toBe('ORDER_PAYMENT');
    expect(p.businessKey).toBe('order:0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11');
    expect(p.entries.map((e) => [e.accountId, e.amount.amount])).toEqual([
      ['wallet:c1', -50000],
      ['system:MERCHANT:VND', 50000],
    ]);
  });

  it.each([0, -1])('rejects a non-positive amount (%d)', (amount) => {
    expect(() => make(amount)).toThrow(InvalidLedgerTransactionError);
  });

  it('rejects an order id that makes the business key too long', () => {
    expect(() => make(1, 'x'.repeat(200))).toThrow(InvalidLedgerTransactionError);
  });
});
```

`services/wallet/src/infrastructure/kysely/orders-migration.integration.test.ts`:
```ts
import { createDatabase, dateTime, migrate } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { walletMigrations } from './migrations/index.js';
import { provisionTenants } from './provisioning.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;
const when = () => dateTime(new Date('2026-10-10T10:00:00.000Z'));

beforeAll(async () => {
  testDb = await createTestDatabase('ordersmig');
  db = createDatabase<unknown>(testDb.config);
  await provisionTenants(db, [TenantId.parse('acme')]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const t = (name: string) => sql.id('t_acme', name);
const sqlNumber = async (work: Promise<unknown>): Promise<number | undefined> =>
  work.then(
    () => undefined,
    (error: { number?: number }) => error.number,
  );

describe('003-orders', () => {
  it('accepts ORDER_PAYMENT ledger transactions and still rejects unknown kinds', async () => {
    await sql`insert into ${t('ledger_transactions')} (id, business_key, kind, created_at)
      values ('tx_o1', 'order:1', 'ORDER_PAYMENT', ${when()})`.execute(db);
    expect(
      await sqlNumber(
        sql`insert into ${t('ledger_transactions')} (id, business_key, kind, created_at)
          values ('tx_bad', 'x:1', 'BOGUS', ${when()})`.execute(db),
      ),
    ).toBe(547);
  });

  it('keeps one paid row per order, tied to an existing ledger transaction', async () => {
    await sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
      values ('o1', 'c1', 'tx_o1', 50000, 'VND', ${when()})`.execute(db);
    expect(
      await sqlNumber(
        sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
          values ('o1', 'c1', 'tx_o1', 50000, 'VND', ${when()})`.execute(db),
      ),
    ).toBe(2627);
    expect(
      await sqlNumber(
        sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
          values ('o2', 'c1', 'tx_missing', 50000, 'VND', ${when()})`.execute(db),
      ),
    ).toBe(547);
    expect(
      await sqlNumber(
        sql`insert into ${t('order_payments')} (order_id, customer_id, wallet_transaction_id, amount, currency, paid_at)
          values ('o3', 'c1', 'tx_o1', 0, 'VND', ${when()})`.execute(db),
      ),
    ).toBe(547);
  });

  it('constrains the outbox status and indexes it for the relay', async () => {
    expect(
      await sqlNumber(
        sql`insert into ${t('outbox')} (id, event_type, routing_key, payload, correlation_id, status, attempts, next_attempt_at, created_at)
          values ('e1', 'OrderPaidV1', 'order-paid.v1', '{}', 'c', 'WEIRD', 0, ${when()}, ${when()})`.execute(db),
      ),
    ).toBe(547);
    const columns = await sql<{ name: string }>`
      select c.name from sys.indexes i
      join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
      join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
      where i.name = 'ix_outbox_due' and i.object_id = object_id(N'[t_acme].[outbox]')
      order by ic.key_ordinal`.execute(db);
    expect(columns.rows.map((r) => r.name)).toEqual(['status', 'next_attempt_at', 'id']);
  });

  it('upgrades a tenant that already holds ledger data without losing it', async () => {
    const schema = 't_legacy';
    await sql.raw(`create schema [${schema}]`).execute(db);
    const all = walletMigrations(schema);
    await migrate(
      db,
      { '001-ledger': all['001-ledger']!, '002-topups': all['002-topups']! },
      { migrationTableSchema: schema },
    );
    await sql`insert into ${sql.id(schema, 'ledger_transactions')} (id, business_key, kind, created_at)
      values ('tx_old', 'topup:old', 'TOPUP', ${when()})`.execute(db);

    expect(await provisionTenants(db, [TenantId.parse('legacy')])).toEqual({ legacy: ['003-orders'] });

    const rows = await sql<{ id: string }>`select id from ${sql.id(schema, 'ledger_transactions')}`.execute(db);
    expect(rows.rows.map((r) => r.id)).toEqual(['tx_old']);
    await sql`insert into ${sql.id(schema, 'ledger_transactions')} (id, business_key, kind, created_at)
      values ('tx_new', 'order:legacy', 'ORDER_PAYMENT', ${when()})`.execute(db);
  });
});
```

Cập nhật `provisioning.integration.test.ts`: trong ca "creates both tenant schemas, applies every migration, and is idempotent" đổi hai mảng thành `['001-ledger', '002-topups', '003-orders']`; trong ca "puts the same tables in each tenant schema…" thêm `'order_payments'` và `'outbox'` vào danh sách bảng kỳ vọng (giữ thứ tự chữ cái: `…, 'ledger_transactions', 'order_payments', 'outbox', 'processed_messages', 'topups'`).

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet/src/domain/ledger-transaction.test.ts` và `corepack pnpm test:integration orders-migration provisioning`
Expected: FAIL (`orderPayment` chưa có; migration chưa có).

- [ ] **Step 3: Cài đặt**

`services/wallet/src/domain/ledger-transaction.ts`: đổi `export type LedgerTransactionKind = 'TOPUP';` thành `export type LedgerTransactionKind = 'TOPUP' | 'ORDER_PAYMENT';` và thêm method tĩnh ngay sau `topup(...)`:
```ts
  /** Trả order: ví `−amount`, MERCHANT `+amount`, khóa nghiệp vụ `order:<orderId>`. */
  static orderPayment(input: {
    id: string;
    orderId: string;
    walletAccountId: string;
    merchantAccountId: string;
    amount: Money;
    now: Date;
  }): LedgerTransaction {
    if (!input.amount.isPositive()) {
      throw new InvalidLedgerTransactionError('an order payment amount must be positive');
    }
    return LedgerTransaction.create({
      id: input.id,
      businessKey: `order:${input.orderId}`,
      kind: 'ORDER_PAYMENT',
      entries: [
        { accountId: input.walletAccountId, amount: input.amount.negate() },
        { accountId: input.merchantAccountId, amount: input.amount },
      ],
      now: input.now,
    });
  }
```

`services/wallet/src/infrastructure/kysely/migrations/003-orders.ts`:
```ts
import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Trả order từ ví: mở rộng loại giao dịch ledger, ghi nhớ order đã trả và outbox. Chạy trong schema của một tenant. */
export const ordersMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    // Đã kiểm chứng: drop + add trên bảng có dữ liệu và trigger bất biến; ràng buộc vẫn "trusted".
    await sql`alter table ${t('ledger_transactions')} drop constraint ck_ledger_transactions_kind`.execute(db);
    await sql`
      alter table ${t('ledger_transactions')}
      add constraint ck_ledger_transactions_kind check (kind in ('TOPUP', 'ORDER_PAYMENT'))`.execute(db);

    await sql`
      create table ${t('order_payments')} (
        order_id nvarchar(64) not null primary key,
        customer_id nvarchar(64) not null,
        wallet_transaction_id nvarchar(64) not null references ${t('ledger_transactions')} (id),
        amount bigint not null,
        currency nvarchar(3) not null,
        paid_at datetime2(3) not null,
        constraint ck_order_payments_amount check (amount > 0),
        constraint ck_order_payments_currency check (currency in ('VND', 'USD'))
      )`.execute(db);

    await sql`
      create table ${t('outbox')} (
        id nvarchar(64) not null primary key,
        event_type nvarchar(64) not null,
        routing_key nvarchar(100) not null,
        payload nvarchar(max) not null,
        correlation_id nvarchar(100) not null,
        status nvarchar(8) not null,
        attempts int not null,
        next_attempt_at datetime2(3) not null,
        created_at datetime2(3) not null,
        sent_at datetime2(3) null,
        constraint ck_outbox_status check (status in ('PENDING', 'SENT'))
      )`.execute(db);
    // Index (status, next_attempt_at, id) là BẮT BUỘC cho `top (1) ... with (updlock, readpast)` của relay.
    await sql`create index ix_outbox_due on ${t('outbox')} (status, next_attempt_at, id)`.execute(db);
  },
});
```

`migrations/index.ts`: thêm `import { ordersMigration } from './003-orders.js';` và khóa `'003-orders': ordersMigration(schema),` sau `'002-topups'`.

`schema.ts`: thêm
```ts
export interface OrderPaymentsTable {
  order_id: string;
  customer_id: string;
  wallet_transaction_id: string;
  amount: ColumnType<string, number, number>;
  currency: string;
  paid_at: Date;
}

export interface OutboxTable {
  id: string;
  event_type: string;
  routing_key: string;
  payload: string;
  correlation_id: string;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  created_at: Date;
  sent_at: Date | null;
}
```
và vào `WalletDatabase` thêm `order_payments: OrderPaymentsTable;` `outbox: OutboxTable;`.

- [ ] **Step 4: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run services/wallet/src/domain
corepack pnpm test:integration orders-migration provisioning
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): ORDER_PAYMENT ledger kind and tenant migration 003 (order_payments, outbox)"
```

---

### Task 5: Cổng ứng dụng, repository `order_payments`/`outbox`, `IdGenerator.eventId`

**Files:**
- Modify: `services/wallet/src/application/ports.ts`, `application/errors.ts`, `infrastructure/system.ts`, `infrastructure/system.test.ts`, `infrastructure/kysely/mappers.ts`, `infrastructure/kysely/unit-of-work.ts`, `test-support.ts`, `application/apply-payment-result.integration.test.ts` (một literal `IdGenerator`)
- Create: `infrastructure/kysely/order-payment.repository.ts`, `infrastructure/kysely/outbox.repository.ts`, `infrastructure/kysely/order-repositories.integration.test.ts`

**Interfaces:**
- Consumes: `Money`, `DuplicateKeyError`, `dateTime`/`sqlDate` (mappers), bảng Task 4.
- Produces (`application/ports.ts`):
  - `IdGenerator` có thêm `eventId(): string` (UUID thật; test dùng chuỗi UUID tất định `00000000-0000-4000-8000-<12 chữ số>`)
  - `interface PaidOrder { orderId: string; customerId: string; walletTransactionId: string; amount: Money; paidAt: Date }`
  - `interface OrderPaymentRepository { find(orderId: string): Promise<PaidOrder | null>; insert(order: PaidOrder): Promise<void> }` — `insert` trùng khóa → `DuplicateKeyError('…', 'order_payment')`
  - `interface NewOutboxMessage { id: string; eventType: string; routingKey: string; payload: string; correlationId: string; createdAt: Date }`; `interface OutboxMessage extends NewOutboxMessage { attempts: number; nextAttemptAt: Date }`
  - `interface OutboxRepository { add(message: NewOutboxMessage): Promise<void>` (status `PENDING`, `attempts 0`, `next_attempt_at = createdAt`); `lockNextDue(now: Date): Promise<OutboxMessage | null>` (dòng `PENDING` đến hạn cũ nhất, `updlock, readpast, rowlock`); `lease(id: string, until: Date): Promise<void>` (đẩy `next_attempt_at`); `markSent(id: string, sentAt: Date): Promise<void>`; `recordFailure(id: string, nextAttemptAt: Date): Promise<void>` (`attempts + 1`, đặt lịch) }`
  - `Repositories` có thêm `orderPayments: OrderPaymentRepository; outbox: OutboxRepository`
  - `type PublishOutcome = { kind: 'delivered' } | { kind: 'unroutable' } | { kind: 'failed'; error: string }`; `interface EventPublisher { publish(message: OutboxMessage): Promise<PublishOutcome> }` (port cho relay; không bao giờ ném)
  - `DuplicateKeyError.source` mở rộng thành `'inbox' | 'ledger' | 'order_payment'`
  - (`test-support.ts`) `silentLogger: Logger`; `fundWallet(h, { tenant?, customer, amount, currency? }): Promise<void>` — nạp tiền thật bằng `seedTopup` + `ApplyPaymentResult`

- [ ] **Step 1: Viết test thất bại**

`services/wallet/src/infrastructure/kysely/order-repositories.integration.test.ts`:
```ts
import { Money } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '../../application/errors.js';
import type { NewOutboxMessage } from '../../application/ports.js';
import { Account } from '../../domain/account.js';
import { CustomerId } from '../../domain/customer-id.js';
import { LedgerTransaction } from '../../domain/ledger-transaction.js';
import { createHarness, type Harness } from '../../test-support.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.123Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

beforeAll(async () => {
  h = await createHarness();
  for (const tenant of [h.acme, h.beta]) {
    await h.uow.run(tenant, ({ accounts }) =>
      accounts.insert(Account.openWallet({ customerId: CustomerId.parse('c1'), currency: 'VND', now: t0 })),
    );
  }
});
afterAll(async () => {
  await h.close();
});
// `lockNextDue` trả dòng đến hạn CŨ NHẤT của tenant, nên mỗi ca bắt đầu từ outbox "sạch" (mọi dòng cũ coi như đã gửi).
beforeEach(async () => {
  for (const schema of ['t_acme', 't_beta']) {
    await h.db.withSchema(schema).updateTable('outbox').set({ status: 'SENT' }).execute();
  }
});

const message = (id: string, createdAt = t0): NewOutboxMessage => ({
  id,
  eventType: 'OrderPaidV1',
  routingKey: 'order-paid.v1',
  payload: JSON.stringify({ id }),
  correlationId: 'corr-1',
  createdAt,
});

async function postOrderTransaction(tenant = h.acme, id = 'tx_a', orderId = 'o1'): Promise<void> {
  await h.uow.run(tenant, ({ ledger }) =>
    ledger.post(
      LedgerTransaction.orderPayment({
        id,
        orderId,
        walletAccountId: 'wallet:c1',
        merchantAccountId: 'system:MERCHANT:VND',
        amount: Money.of(1000, 'VND'),
        now: t0,
      }),
    ),
  );
}

describe('KyselyOrderPaymentRepository', () => {
  it('round-trips a paid order with exact money and milliseconds', async () => {
    await postOrderTransaction(h.acme, 'tx_a', 'o1');
    const paid = { orderId: 'o1', customerId: 'c1', walletTransactionId: 'tx_a', amount: Money.of(1000, 'VND'), paidAt: t0 };
    await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.insert(paid));
    const found = await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.find('o1'));
    expect(found).toEqual(paid);
  });

  it('answers null for an unknown order and for an order of another tenant', async () => {
    expect(await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.find('nope'))).toBeNull();
    expect(await h.uow.run(h.beta, ({ orderPayments }) => orderPayments.find('o1'))).toBeNull();
  });

  it('refuses a second payment for the same order with a DuplicateKeyError tagged order_payment', async () => {
    await postOrderTransaction(h.acme, 'tx_b', 'o9');
    const paid = { orderId: 'o9', customerId: 'c1', walletTransactionId: 'tx_b', amount: Money.of(1000, 'VND'), paidAt: t0 };
    await h.uow.run(h.acme, ({ orderPayments }) => orderPayments.insert(paid));
    await expect(h.uow.run(h.acme, ({ orderPayments }) => orderPayments.insert(paid))).rejects.toSatisfy(
      (error: unknown) => error instanceof DuplicateKeyError && error.source === 'order_payment',
    );
  });
});

describe('KyselyOutboxRepository', () => {
  it('adds PENDING rows that are due at their creation time, oldest first', async () => {
    await h.uow.run(h.acme, async ({ outbox }) => {
      await outbox.add(message('ob_2', at(2)));
      await outbox.add(message('ob_1', at(1)));
    });
    expect(await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(0)))).toBeNull();
    const first = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(5)));
    expect(first).toEqual({
      id: 'ob_1',
      eventType: 'OrderPaidV1',
      routingKey: 'order-paid.v1',
      payload: JSON.stringify({ id: 'ob_1' }),
      correlationId: 'corr-1',
      createdAt: at(1),
      attempts: 0,
      nextAttemptAt: at(1),
    });
  });

  it('does not hand the same row out again while it is leased, and gives it back after the lease', async () => {
    await h.uow.run(h.acme, ({ outbox }) => outbox.add(message('ob_lease', at(100))));
    const claimed = await h.uow.run(h.acme, async ({ outbox }) => {
      const row = await outbox.lockNextDue(at(100));
      if (row) await outbox.lease(row.id, at(160));
      return row;
    });
    expect(claimed?.id).toBe('ob_lease');
    const during = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(130)));
    expect(during).toBeNull();
    const after = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(161)));
    expect(after?.id).toBe('ob_lease');
  });

  it('records a failure by counting the attempt and rescheduling, and a send by retiring the row', async () => {
    await h.uow.run(h.acme, ({ outbox }) => outbox.add(message('ob_fail', at(200))));
    await h.uow.run(h.acme, ({ outbox }) => outbox.recordFailure('ob_fail', at(210)));
    const retry = await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(210)));
    expect(retry).toMatchObject({ id: 'ob_fail', attempts: 1, nextAttemptAt: at(210) });

    await h.uow.run(h.acme, ({ outbox }) => outbox.markSent('ob_fail', at(211)));
    const row = await h.db.withSchema('t_acme').selectFrom('outbox').selectAll().where('id', '=', 'ob_fail').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'SENT', sent_at: at(211) });
    expect(await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(9999)))).toBeNull();
  });

  it('lets two concurrent transactions each take a different due row (READPAST)', async () => {
    await h.uow.run(h.beta, async ({ outbox }) => {
      await outbox.add(message('rp_1', at(300)));
      await outbox.add(message('rp_2', at(301)));
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let firstId: string | undefined;
    const first = h.uow.run(h.beta, async ({ outbox }) => {
      firstId = (await outbox.lockNextDue(at(400)))?.id;
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = await h.uow.run(h.beta, ({ outbox }) => outbox.lockNextDue(at(400)));
    release();
    await first;
    expect(firstId).toBe('rp_1');
    expect(second?.id).toBe('rp_2');
  });

  it('keeps tenants apart', async () => {
    await h.uow.run(h.acme, ({ outbox }) => outbox.add(message('ob_acme_only', at(500))));
    expect(await h.uow.run(h.beta, ({ outbox }) => outbox.lockNextDue(at(900)))).toBeNull();
    expect((await h.uow.run(h.acme, ({ outbox }) => outbox.lockNextDue(at(900))))?.id).toBe('ob_acme_only');
  });
});
```
Bổ sung vào `services/wallet/src/infrastructure/system.test.ts` trong `describe('RandomIdGenerator')` một ca:
```ts
  it('produces event ids that are valid UUIDs, as the event schemas require', () => {
    const ids = new RandomIdGenerator();
    expect(ids.eventId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(ids.eventId()).not.toBe(ids.eventId());
  });
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration order-repositories` và `corepack pnpm exec vitest run services/wallet/src/infrastructure/system.test.ts`
Expected: FAIL.

- [ ] **Step 3: Cài đặt**

`application/errors.ts`: đổi kiểu `source` của `DuplicateKeyError` thành `'inbox' | 'ledger' | 'order_payment'`.

`application/ports.ts`: thêm `eventId(): string;` vào `IdGenerator`; thêm vào cuối file (sau `PaymentGateway`) các khai báo `PaidOrder`, `OrderPaymentRepository`, `NewOutboxMessage`, `OutboxMessage`, `OutboxRepository`, `PublishOutcome`, `EventPublisher` đúng như mục Interfaces (kèm comment tiếng Việt ngắn), và thêm hai trường vào `Repositories`:
```ts
export interface Repositories {
  accounts: AccountRepository;
  ledger: LedgerRepository;
  topups: TopupRepository;
  idempotency: IdempotencyStore;
  inbox: Inbox;
  orderPayments: OrderPaymentRepository;
  outbox: OutboxRepository;
}
```

`infrastructure/system.ts`: thêm vào `RandomIdGenerator`
```ts
  eventId(): string {
    return randomUUID();
  }
```

`infrastructure/kysely/mappers.ts` thêm (cùng import `PaidOrder`, `OutboxMessage`, `NewOutboxMessage` từ `../../application/ports.js` và `OrderPaymentsTable`, `OutboxTable` từ `./schema.js`):
```ts
export function rowToPaidOrder(row: Selectable<OrderPaymentsTable>): PaidOrder {
  return {
    orderId: row.order_id,
    customerId: row.customer_id,
    walletTransactionId: row.wallet_transaction_id,
    amount: Money.of(toSafeInteger(row.amount), row.currency as Currency),
    paidAt: row.paid_at,
  };
}

export function rowToOutbox(row: Selectable<OutboxTable>): OutboxMessage {
  return {
    id: row.id,
    eventType: row.event_type,
    routingKey: row.routing_key,
    payload: row.payload,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

export function outboxToRow(message: NewOutboxMessage): Insertable<OutboxTable> {
  return {
    id: message.id,
    event_type: message.eventType,
    routing_key: message.routingKey,
    payload: message.payload,
    correlation_id: message.correlationId,
    status: 'PENDING',
    attempts: 0,
    next_attempt_at: sqlDate(message.createdAt),
    created_at: sqlDate(message.createdAt),
    sent_at: null,
  };
}
```

`infrastructure/kysely/order-payment.repository.ts`:
```ts
import { isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { OrderPaymentRepository, PaidOrder } from '../../application/ports.js';
import { rowToPaidOrder, sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyOrderPaymentRepository implements OrderPaymentRepository {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async find(orderId: string): Promise<PaidOrder | null> {
    const row = await this.db
      .selectFrom('order_payments')
      .selectAll()
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    return row ? rowToPaidOrder(row) : null;
  }

  async insert(order: PaidOrder): Promise<void> {
    try {
      await this.db
        .insertInto('order_payments')
        .values({
          order_id: order.orderId,
          customer_id: order.customerId,
          wallet_transaction_id: order.walletTransactionId,
          amount: order.amount.amount,
          currency: order.amount.currency,
          paid_at: sqlDate(order.paidAt),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`order already paid: ${order.orderId}`, 'order_payment');
      }
      throw error;
    }
  }
}
```

`infrastructure/kysely/outbox.repository.ts`:
```ts
import { dateTime } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { NewOutboxMessage, OutboxMessage, OutboxRepository } from '../../application/ports.js';
import { outboxToRow, rowToOutbox, sqlDate } from './mappers.js';
import type { OutboxTable, WalletDatabase } from './schema.js';

const COLUMNS = sql.raw(
  'id, event_type, routing_key, payload, correlation_id, status, attempts, next_attempt_at, created_at, sent_at',
);

export class KyselyOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async add(message: NewOutboxMessage): Promise<void> {
    await this.db.insertInto('outbox').values(outboxToRow(message)).execute();
  }

  async lockNextDue(now: Date): Promise<OutboxMessage | null> {
    // Cần index ix_outbox_due (status, next_attempt_at, id) khớp ORDER BY để READPAST bỏ qua đúng dòng bị khóa.
    const result = await sql<Selectable<OutboxTable>>`
      select top (1) ${COLUMNS}
      from ${sql.id(this.schema, 'outbox')} with (updlock, readpast, rowlock)
      where status = ${'PENDING'} and next_attempt_at <= ${dateTime(now)}
      order by next_attempt_at, id`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToOutbox(row) : null;
  }

  async lease(id: string, until: Date): Promise<void> {
    await this.db
      .updateTable('outbox')
      .set({ next_attempt_at: sqlDate(until) })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .execute();
  }

  async markSent(id: string, sentAt: Date): Promise<void> {
    await this.db
      .updateTable('outbox')
      .set({ status: 'SENT', sent_at: sqlDate(sentAt) })
      .where('id', '=', id)
      .execute();
  }

  async recordFailure(id: string, nextAttemptAt: Date): Promise<void> {
    await this.db
      .updateTable('outbox')
      .set({ attempts: sql<number>`attempts + 1`, next_attempt_at: sqlDate(nextAttemptAt) })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .execute();
  }
}
```

`unit-of-work.ts`: thêm import hai repository mới và hai dòng trong object trả về:
```ts
        orderPayments: new KyselyOrderPaymentRepository(scoped),
        outbox: new KyselyOutboxRepository(scoped, schema),
```

`test-support.ts`:
- trong `SequentialIds` thêm `#events = 0;` và
```ts
  eventId(): string {
    return `00000000-0000-4000-8000-${String(++this.#events).padStart(12, '0')}`;
  }
```
- thêm (cùng import `ApplyPaymentResult`, `Logger`):
```ts
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Nạp tiền thật vào ví (tạo ví nếu chưa có) bằng đúng luồng nạp: lần nạp PENDING rồi webhook thành công. */
export async function fundWallet(
  h: Harness,
  options: { tenant?: TenantId; customer: string; amount: number; currency?: Currency },
): Promise<void> {
  const seeded = await seedTopup(h, { ...options, state: 'PENDING' });
  const outcome = await new ApplyPaymentResult({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
  }).execute({
    tenant: seeded.tenant,
    eventId: `evt_fund_${seeded.topupId}`,
    type: 'charge.succeeded',
    chargeId: seeded.chargeId,
    reference: seeded.topupId,
    amount: seeded.amount,
    currency: seeded.currency,
  });
  if (outcome !== 'APPLIED') throw new Error(`could not fund wallet: ${outcome}`);
}
```

Chạy `corepack pnpm typecheck`: sửa mọi chỗ khác implement `IdGenerator` bằng object literal — dự kiến duy nhất `application/apply-payment-result.integration.test.ts` (ca rollback): thêm `eventId: () => h.ids.eventId(),` vào literal `ids`.

- [ ] **Step 4: Chạy test, lint, typecheck**

```bash
corepack pnpm test:integration order-repositories
corepack pnpm exec vitest run services/wallet
corepack pnpm test:integration wallet
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS (bộ integration wallet cũ vẫn xanh).

- [ ] **Step 5: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): order payment and outbox repositories, event id generator, fundWallet helper"
```

---

### Task 6: `PayOrder` — trừ ví trả order trong một transaction

**Files:**
- Create: `services/wallet/src/application/order-events.ts`, `application/pay-order.ts`
- Test: `application/order-events.test.ts` (unit), `application/pay-order.integration.test.ts`

**Interfaces:**
- Consumes: `TenantUnitOfWork`, `Repositories`, `Clock`, `IdGenerator` (có `eventId`), `Logger`, `NewOutboxMessage` (Task 5); `Account`, `LedgerTransaction.orderPayment`, `CustomerId`, `InsufficientFundsError`, `DuplicateKeyError`; `eventCatalog`, `OrderPaidV1`, `OrderPaymentFailedV1` từ `@billing/contracts`.
- Produces:
  - `application/order-events.ts`: `interface EventContext { tenantId: string; correlationId: string; eventId: string; now: Date }`; `type PaymentFailureReason = OrderPaymentFailedV1['reason']`; `orderPaidMessage(ctx, { orderId, walletTransactionId, amount: Money, paidAt: Date }): NewOutboxMessage`; `orderPaymentFailedMessage(ctx, { orderId, reason }): NewOutboxMessage` — `id = ctx.eventId`, `eventType` = tên event, `routingKey` từ `eventCatalog`, `payload` là JSON đúng schema, `createdAt = ctx.now`
  - `PayOrder({ uow, clock, ids, log }).execute(input): Promise<PayOrderOutcome>` với `interface PayOrderInput { tenant: TenantId; eventId: string; correlationId: string; orderId: string; customerId: string; amount: number; currency: string }` và `type PayOrderOutcome = { kind: 'PAID'; walletTransactionId: string } | { kind: 'REPLAYED'; walletTransactionId: string } | { kind: 'REJECTED'; reason: PaymentFailureReason } | { kind: 'DUPLICATE' }`
  - Mọi nhánh trừ `DUPLICATE` ghi **đúng một** dòng outbox trong cùng transaction; nhánh từ chối vẫn commit (inbox + outbox).

- [ ] **Step 1: Viết test thất bại**

`services/wallet/src/application/order-events.test.ts`:
```ts
import { validateEvent } from '@billing/contracts';
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { orderPaidMessage, orderPaymentFailedMessage } from './order-events.js';

const ctx = {
  tenantId: 'acme',
  correlationId: 'corr-1',
  eventId: '00000000-0000-4000-8000-000000000001',
  now: new Date('2026-10-10T10:00:00.000Z'),
};
const orderId = '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11';

describe('order events', () => {
  it('builds an OrderPaidV1 outbox message that satisfies the published schema', () => {
    const message = orderPaidMessage(ctx, {
      orderId,
      walletTransactionId: 'tx_1',
      amount: Money.of(150000, 'VND'),
      paidAt: new Date('2026-10-10T09:59:59.000Z'),
    });
    expect(message).toMatchObject({
      id: ctx.eventId,
      eventType: 'OrderPaidV1',
      routingKey: 'order-paid.v1',
      correlationId: 'corr-1',
      createdAt: ctx.now,
    });
    const payload = JSON.parse(message.payload) as unknown;
    expect(validateEvent('OrderPaidV1', payload).ok).toBe(true);
    expect(payload).toMatchObject({
      eventId: ctx.eventId,
      occurredAtUtc: '2026-10-10T10:00:00.000Z',
      tenantId: 'acme',
      orderId,
      walletTransactionId: 'tx_1',
      amount: 150000,
      currency: 'VND',
      paidAtUtc: '2026-10-10T09:59:59.000Z',
    });
  });

  it.each(['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'] as const)(
    'builds a valid OrderPaymentFailedV1 for %s',
    (reason) => {
      const message = orderPaymentFailedMessage(ctx, { orderId, reason });
      expect(message).toMatchObject({ eventType: 'OrderPaymentFailedV1', routingKey: 'order-payment-failed.v1' });
      const result = validateEvent('OrderPaymentFailedV1', JSON.parse(message.payload));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.reason).toBe(reason);
    },
  );
});
```

`services/wallet/src/application/pay-order.integration.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { validateEvent } from '@billing/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import {
  createHarness,
  expectLedgerInvariants,
  fundWallet,
  seedTopup,
  silentLogger,
  type Harness,
} from '../test-support.js';
import { ApplyPaymentResult } from './apply-payment-result.js';
import { PayOrder, type PayOrderInput } from './pay-order.js';
import type { Logger } from './ports.js';

let h: Harness;
let pay: PayOrder;
let warnings: object[];
let counter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  warnings = [];
  const log: Logger = { ...silentLogger, warn: (details) => warnings.push(details) };
  pay = new PayOrder({ uow: h.uow, clock: h.clock, ids: h.ids, log });
  h.clock.set('2026-10-10T10:00:00.000Z');
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

const newCustomer = () => `pc${++counter}`;
const order = (customer: string, overrides: Partial<PayOrderInput> = {}): PayOrderInput => ({
  tenant: h.acme,
  eventId: randomUUID(),
  correlationId: 'corr-1',
  orderId: randomUUID(),
  customerId: customer,
  amount: 50000,
  currency: 'VND',
  ...overrides,
});

const schema = (tenant: TenantId) => `t_${tenant.value}`;
const balance = async (tenant: TenantId, accountId: string): Promise<number> =>
  Number(
    (
      await h.db.withSchema(schema(tenant)).selectFrom('accounts').select('balance').where('id', '=', accountId).executeTakeFirstOrThrow()
    ).balance,
  );
const outboxFor = async (orderId: string, tenant = h.acme) =>
  (
    await h.db
      .withSchema(schema(tenant))
      .selectFrom('outbox')
      .selectAll()
      .where('payload', 'like', `%${orderId}%`)
      .orderBy('created_at')
      .execute()
  ).map((row) => ({ ...row, body: JSON.parse(row.payload) as Record<string, unknown> }));
const ledgerFor = async (orderId: string, tenant = h.acme) =>
  h.db.withSchema(schema(tenant)).selectFrom('ledger_transactions').selectAll().where('business_key', '=', `order:${orderId}`).execute();
const paidRows = async (orderId: string, tenant = h.acme) =>
  h.db.withSchema(schema(tenant)).selectFrom('order_payments').selectAll().where('order_id', '=', orderId).execute();

describe('PayOrder — paying', () => {
  it('debits the wallet, credits the merchant, posts the ledger, remembers the order and queues OrderPaidV1', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 120000 });
    const merchantBefore = await balance(h.acme, 'system:MERCHANT:VND');
    const input = order(customer);
    h.clock.advanceSeconds(10);

    const outcome = await pay.execute(input);

    expect(outcome.kind).toBe('PAID');
    const transactionId = outcome.kind === 'PAID' ? outcome.walletTransactionId : '';
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(70000);
    expect(await balance(h.acme, 'system:MERCHANT:VND')).toBe(merchantBefore + 50000);
    const [tx] = await ledgerFor(input.orderId);
    expect(tx).toMatchObject({ id: transactionId, kind: 'ORDER_PAYMENT' });
    expect(await paidRows(input.orderId)).toEqual([
      expect.objectContaining({ customer_id: customer, wallet_transaction_id: transactionId, currency: 'VND', paid_at: new Date('2026-10-10T10:00:10.000Z') }),
    ]);
    const rows = await outboxFor(input.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'PENDING', event_type: 'OrderPaidV1', routing_key: 'order-paid.v1', correlation_id: 'corr-1' });
    expect(validateEvent('OrderPaidV1', rows[0]?.body).ok).toBe(true);
    expect(rows[0]?.body).toMatchObject({ orderId: input.orderId, walletTransactionId: transactionId, amount: 50000, currency: 'VND', tenantId: 'acme' });
  });

  it('can pay with the whole balance, leaving exactly zero', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 50000 });
    expect((await pay.execute(order(customer))).kind).toBe('PAID');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(0);
  });
});

describe('PayOrder — refusals queue OrderPaymentFailedV1 and still commit', () => {
  it('INSUFFICIENT_FUNDS leaves money and ledger alone', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 49999 });
    const input = order(customer);
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(49999);
    expect(await ledgerFor(input.orderId)).toHaveLength(0);
    expect(await paidRows(input.orderId)).toHaveLength(0);
    const rows = await outboxFor(input.orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_type: 'OrderPaymentFailedV1', routing_key: 'order-payment-failed.v1' });
    expect(rows[0]?.body).toMatchObject({ reason: 'INSUFFICIENT_FUNDS', orderId: input.orderId });
    expect(validateEvent('OrderPaymentFailedV1', rows[0]?.body).ok).toBe(true);
  });

  it.each([
    ['no wallet', 'nobody-here'],
    ['an id that cannot name a wallet', 'bad id!'],
  ])('WALLET_NOT_FOUND for %s', async (_name, customerId) => {
    const input = order(customerId);
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'WALLET_NOT_FOUND' });
    expect((await outboxFor(input.orderId))[0]?.body).toMatchObject({ reason: 'WALLET_NOT_FOUND' });
  });

  it('CURRENCY_MISMATCH when the wallet currency differs from the order currency', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer, { currency: 'USD', amount: 100 });
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'CURRENCY_MISMATCH' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(100000);
  });

  it('does not see a wallet that lives in another tenant', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer, { tenant: h.beta });
    expect(await pay.execute(input)).toEqual({ kind: 'REJECTED', reason: 'WALLET_NOT_FOUND' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(100000);
    expect(await outboxFor(input.orderId, h.beta)).toHaveLength(1);
    expect(await outboxFor(input.orderId, h.acme)).toHaveLength(0);
  });

  it('forgets a refusal: after the customer tops up, the same order can be paid', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 10000 });
    const orderId = randomUUID();
    expect((await pay.execute(order(customer, { orderId }))).kind).toBe('REJECTED');
    await fundWallet(h, { customer, amount: 100000 });
    expect((await pay.execute(order(customer, { orderId }))).kind).toBe('PAID');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(60000);
    expect((await outboxFor(orderId)).map((r) => r.event_type)).toEqual(['OrderPaymentFailedV1', 'OrderPaidV1']);
  });
});

describe('PayOrder — duplicates never charge twice', () => {
  it('answers DUPLICATE for a redelivered event id and queues nothing new', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer);
    expect((await pay.execute(input)).kind).toBe('PAID');
    expect(await pay.execute(input)).toEqual({ kind: 'DUPLICATE' });
    expect(await outboxFor(input.orderId)).toHaveLength(1);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
  });

  it('replays OrderPaidV1 with the same walletTransactionId when the order is requested again under a new event id', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const first = order(customer);
    const paid = await pay.execute(first);
    const again = await pay.execute({ ...first, eventId: randomUUID() });

    expect(again).toEqual({ kind: 'REPLAYED', walletTransactionId: paid.kind === 'PAID' ? paid.walletTransactionId : '?' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
    expect(await ledgerFor(first.orderId)).toHaveLength(1);
    const rows = await outboxFor(first.orderId);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body.walletTransactionId).toBe(rows[1]?.body.walletTransactionId);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it.each([
    ['a different amount', { amount: 60000 }],
    ['a different currency', { currency: 'USD', amount: 50 }],
  ])('answers CONFLICT and warns when a paid order comes again with %s', async (_name, override) => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const first = order(customer);
    await pay.execute(first);
    expect(await pay.execute({ ...first, ...override, eventId: randomUUID() })).toEqual({ kind: 'REJECTED', reason: 'CONFLICT' });
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('answers CONFLICT when a paid order comes again for another customer', async () => {
    const customer = newCustomer();
    const other = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    await fundWallet(h, { customer: other, amount: 100000 });
    const first = order(customer);
    await pay.execute(first);
    expect(await pay.execute({ ...first, customerId: other, eventId: randomUUID() })).toEqual({ kind: 'REJECTED', reason: 'CONFLICT' });
    expect(await balance(h.acme, `wallet:${other}`)).toBe(100000);
  });
});

describe('PayOrder — concurrency', () => {
  it('charges once when the same event arrives ten times at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const input = order(customer);
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => pay.execute(input)));
    expect(outcomes.filter((o) => o.kind === 'PAID')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'DUPLICATE')).toHaveLength(9);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
    expect(await ledgerFor(input.orderId)).toHaveLength(1);
  });

  it('charges once when the same order arrives under ten different event ids at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const base = order(customer);
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => pay.execute({ ...base, eventId: randomUUID() })),
    );
    expect(outcomes.filter((o) => o.kind === 'PAID')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'REPLAYED')).toHaveLength(9);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
    expect(await ledgerFor(base.orderId)).toHaveLength(1);
    expect(await paidRows(base.orderId)).toHaveLength(1);
  });

  it('never overspends: with money for three of six simultaneous orders exactly three are paid', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 3000 });
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => pay.execute(order(customer, { amount: 1000 }))),
    );
    expect(outcomes.filter((o) => o.kind === 'PAID')).toHaveLength(3);
    expect(outcomes.filter((o) => o.kind === 'REJECTED')).toHaveLength(3);
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(0);
  });

  it('a top-up settling while orders are being paid keeps the books exact and deadlock-free', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 5000 });
    const seeded = await seedTopup(h, { customer, amount: 7000 });
    const apply = new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });
    const results = await Promise.all([
      apply.execute({ tenant: h.acme, eventId: randomUUID(), type: 'charge.succeeded', chargeId: seeded.chargeId, reference: seeded.topupId, amount: 7000, currency: 'VND' }),
      pay.execute(order(customer, { amount: 2000 })),
      pay.execute(order(customer, { amount: 2000 })),
    ]);
    expect(results[0]).toBe('APPLIED');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(8000);
  });
});

describe('PayOrder — atomicity', () => {
  it('rolls back everything, inbox included, when the ledger id cannot be generated, so the retry pays', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const failing = new PayOrder({
      uow: h.uow,
      clock: h.clock,
      ids: {
        topupId: () => h.ids.topupId(),
        eventId: () => h.ids.eventId(),
        transactionId: () => {
          throw new Error('id generator down');
        },
      },
      log: silentLogger,
    });
    const input = order(customer);
    await expect(failing.execute(input)).rejects.toThrow('id generator down');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(100000);
    expect(await outboxFor(input.orderId)).toHaveLength(0);
    expect((await pay.execute(input)).kind).toBe('PAID');
    expect(await balance(h.acme, `wallet:${customer}`)).toBe(50000);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet/src/application/order-events.test.ts` và `corepack pnpm test:integration pay-order`
Expected: FAIL (các module chưa tồn tại).

- [ ] **Step 3: Cài đặt**

`services/wallet/src/application/order-events.ts`:
```ts
import { eventCatalog, type OrderPaidV1, type OrderPaymentFailedV1 } from '@billing/contracts';
import type { Money } from '@billing/money';
import type { NewOutboxMessage } from './ports.js';

export interface EventContext {
  tenantId: string;
  correlationId: string;
  eventId: string;
  now: Date;
}

export type PaymentFailureReason = OrderPaymentFailedV1['reason'];

/** Dựng dòng outbox cho `OrderPaidV1`; payload đúng schema đã phát hành. */
export function orderPaidMessage(
  ctx: EventContext,
  input: { orderId: string; walletTransactionId: string; amount: Money; paidAt: Date },
): NewOutboxMessage {
  const payload: OrderPaidV1 = {
    eventId: ctx.eventId,
    occurredAtUtc: ctx.now.toISOString(),
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    orderId: input.orderId,
    walletTransactionId: input.walletTransactionId,
    amount: input.amount.amount,
    currency: input.amount.currency,
    paidAtUtc: input.paidAt.toISOString(),
  };
  return {
    id: ctx.eventId,
    eventType: 'OrderPaidV1',
    routingKey: eventCatalog.OrderPaidV1.routingKey,
    payload: JSON.stringify(payload),
    correlationId: ctx.correlationId,
    createdAt: ctx.now,
  };
}

export function orderPaymentFailedMessage(
  ctx: EventContext,
  input: { orderId: string; reason: PaymentFailureReason },
): NewOutboxMessage {
  const payload: OrderPaymentFailedV1 = {
    eventId: ctx.eventId,
    occurredAtUtc: ctx.now.toISOString(),
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    orderId: input.orderId,
    reason: input.reason,
  };
  return {
    id: ctx.eventId,
    eventType: 'OrderPaymentFailedV1',
    routingKey: eventCatalog.OrderPaymentFailedV1.routingKey,
    payload: JSON.stringify(payload),
    correlationId: ctx.correlationId,
    createdAt: ctx.now,
  };
}
```

`services/wallet/src/application/pay-order.ts`:
```ts
import { Money, type Currency } from '@billing/money';
import { Account } from '../domain/account.js';
import { CustomerId } from '../domain/customer-id.js';
import { InsufficientFundsError, InvalidCustomerError } from '../domain/errors.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import { DuplicateKeyError } from './errors.js';
import {
  orderPaidMessage,
  orderPaymentFailedMessage,
  type EventContext,
  type PaymentFailureReason,
} from './order-events.js';
import type { Clock, IdGenerator, Logger, Repositories, TenantUnitOfWork } from './ports.js';

export interface PayOrderInput {
  tenant: TenantId;
  /** `eventId` của OrderReadyForPaymentV1: khóa của inbox. */
  eventId: string;
  correlationId: string;
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
}

export type PayOrderOutcome =
  | { kind: 'PAID'; walletTransactionId: string }
  | { kind: 'REPLAYED'; walletTransactionId: string }
  | { kind: 'REJECTED'; reason: PaymentFailureReason }
  | { kind: 'DUPLICATE' };

const CONSUMER = 'orders-events';

function parseCustomer(raw: string): CustomerId | null {
  try {
    return CustomerId.parse(raw);
  } catch (error) {
    if (error instanceof InvalidCustomerError) return null;
    throw error;
  }
}

/**
 * Trả một order từ ví trong MỘT transaction: inbox → (đã trả?) → ví/đồng tiền → khóa ví + MERCHANT → sổ kép →
 * `order_payments` → outbox. Nhánh từ chối vẫn commit (inbox + outbox). Chỉ lần trả thành công được ghi nhớ theo orderId.
 */
export class PayOrder {
  constructor(
    private readonly deps: { uow: TenantUnitOfWork; clock: Clock; ids: IdGenerator; log: Logger },
  ) {}

  async execute(input: PayOrderInput): Promise<PayOrderOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.uow.run(input.tenant, (repositories) => this.pay(repositories, input));
      } catch (error) {
        if (!(error instanceof DuplicateKeyError)) throw error;
        if (error.source === 'inbox') return { kind: 'DUPLICATE' };
        // Hai yêu cầu cùng orderId (eventId khác nhau) đua nhau: bên thua vấp khóa duy nhất của sổ cái hoặc
        // `order_payments` và giao dịch đã rollback; chạy lại một lần sẽ thấy khoản trả của bên thắng và phát lại.
        if (attempt >= 1) throw error;
      }
    }
  }

  private async pay(repositories: Repositories, input: PayOrderInput): Promise<PayOrderOutcome> {
    const { accounts, ledger, inbox, orderPayments, outbox } = repositories;
    const now = this.deps.clock.now();
    const context = (): EventContext => ({
      tenantId: input.tenant.value,
      correlationId: input.correlationId,
      eventId: this.deps.ids.eventId(),
      now,
    });
    const reject = async (reason: PaymentFailureReason): Promise<PayOrderOutcome> => {
      await outbox.add(orderPaymentFailedMessage(context(), { orderId: input.orderId, reason }));
      return { kind: 'REJECTED', reason };
    };

    await inbox.record(CONSUMER, input.eventId, now);

    const money = Money.of(input.amount, input.currency as Currency);

    const paid = await orderPayments.find(input.orderId);
    if (paid) {
      const same =
        paid.customerId === input.customerId &&
        paid.amount.amount === money.amount &&
        paid.amount.currency === money.currency;
      if (!same) {
        this.deps.log.warn(
          { tenantId: input.tenant.value, orderId: input.orderId, eventId: input.eventId },
          'order already paid with different details; refusing',
        );
        return reject('CONFLICT');
      }
      await outbox.add(
        orderPaidMessage(context(), {
          orderId: input.orderId,
          walletTransactionId: paid.walletTransactionId,
          amount: paid.amount,
          paidAt: paid.paidAt,
        }),
      );
      return { kind: 'REPLAYED', walletTransactionId: paid.walletTransactionId };
    }

    const customerId = parseCustomer(input.customerId);
    if (!customerId) return reject('WALLET_NOT_FOUND');
    const walletId = Account.walletId(customerId);
    const wallet = await accounts.find(walletId);
    if (!wallet) return reject('WALLET_NOT_FOUND');
    if (wallet.toProps().currency !== money.currency) return reject('CURRENCY_MISMATCH');

    // Khóa theo thứ tự id tăng dần (cùng quy ước với ApplyPaymentResult) nên không deadlock với việc nạp tiền.
    const merchantId = Account.systemId('MERCHANT', money.currency);
    const locked = await accounts.lockMany([walletId, merchantId]);
    const byId = new Map(locked.map((account) => [account.toProps().id, account]));
    const lockedWallet = byId.get(walletId);
    const merchant = byId.get(merchantId);
    if (!lockedWallet || !merchant) throw new Error(`missing account for order ${input.orderId}`);

    let debited: Account;
    try {
      debited = lockedWallet.apply(money.negate());
    } catch (error) {
      if (error instanceof InsufficientFundsError) return reject('INSUFFICIENT_FUNDS');
      throw error;
    }
    await accounts.saveBalance(debited);
    await accounts.saveBalance(merchant.apply(money));

    const transactionId = this.deps.ids.transactionId();
    await ledger.post(
      LedgerTransaction.orderPayment({
        id: transactionId,
        orderId: input.orderId,
        walletAccountId: walletId,
        merchantAccountId: merchantId,
        amount: money,
        now,
      }),
    );
    await orderPayments.insert({
      orderId: input.orderId,
      customerId: customerId.value,
      walletTransactionId: transactionId,
      amount: money,
      paidAt: now,
    });
    await outbox.add(
      orderPaidMessage(context(), {
        orderId: input.orderId,
        walletTransactionId: transactionId,
        amount: money,
        paidAt: now,
      }),
    );
    return { kind: 'PAID', walletTransactionId: transactionId };
  }
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run services/wallet/src/application/order-events.test.ts
corepack pnpm test:integration pay-order
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS, gồm ca 10 event cùng id (đúng 1 `PAID`), 10 event khác id cùng order (1 `PAID` + 9 `REPLAYED`, chứng minh đường chạy lại sau `DuplicateKeyError`), 6 order đồng thời với tiền cho 3, và bất biến sổ cái sau mỗi test. Nếu ca "ten different event ids" đỏ ở chỗ nhận `DuplicateKeyError` lần hai, đó là lỗi thật của thứ tự khóa/tìm kiếm — điều tra, không nới test.

- [ ] **Step 5: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): PayOrder (inbox, replay/conflict, ledger ORDER_PAYMENT, outbox) with concurrency tests"
```

---

### Task 7: `RelayOutbox` và `AmqpEventPublisher`

**Files:**
- Modify: `services/wallet/package.json` (qua pnpm)
- Create: `services/wallet/src/application/relay-outbox.ts`, `infrastructure/amqp-event-publisher.ts`
- Test: `application/relay-outbox.integration.test.ts`, `infrastructure/amqp-event-publisher.test.ts`

**Interfaces:**
- Consumes: `TenantUnitOfWork`, `OutboxRepository`, `EventPublisher`, `OutboxMessage`, `PublishOutcome`, `Clock`, `Logger` (Task 5); `ConfirmPublisher` từ `@billing/messaging` (Task 3).
- Produces:
  - `DEFAULT_OUTBOX_BACKOFF_SECONDS = [1, 5, 30, 120, 600]`
  - `RelayOutbox({ uow, publisher: EventPublisher, clock, log, backoffSeconds: readonly number[], leaseSeconds?: number }): { executeNextDue(tenant): Promise<RelayOutcome | null>; execute(tenant, limit?: number, options?: { shouldContinue?: () => boolean }): Promise<RelayReport> }` với `type RelayOutcome = 'SENT' | 'UNROUTABLE' | 'FAILED'` và `interface RelayReport { sent: number; unroutable: number; failed: number }`. Quy trình mỗi dòng: (a) transaction ngắn: `lockNextDue` + `lease` (mặc định 60 s); (b) `publisher.publish` **ngoài transaction** (ném lỗi cũng bị coi là `failed`); (c) transaction mới: `delivered` → `markSent`; ngược lại `recordFailure` hẹn lại sau `backoff[min(attempts, len−1)]` giây (không bao giờ bỏ dòng). `execute` lặp tối đa `limit` (mặc định 50) lần, kiểm `shouldContinue` **trước** mỗi lần chiếm, dừng khi hết việc. Log (sau commit): `warn` cho `UNROUTABLE` ("chưa có queue nhận"), `error` cho `FAILED`; không log payload.
  - `AmqpEventPublisher(publisher: Pick<ConfirmPublisher, 'publish'>) implements EventPublisher` — publish lên exchange `billing.events` (`BILLING_EVENTS_EXCHANGE`) với `routingKey`, `messageId = id`, `type = eventType`, `correlationId`, `body = payload`.

- [ ] **Step 1: Phụ thuộc**

```bash
corepack pnpm --filter @billing/wallet-service add @billing/messaging@workspace:*
```
Expected: không lỗi.

- [ ] **Step 2: Viết test thất bại**

`services/wallet/src/infrastructure/amqp-event-publisher.test.ts`:
```ts
import type { OutgoingMessage, PublishResult } from '@billing/messaging';
import { describe, expect, it } from 'vitest';
import type { OutboxMessage } from '../application/ports.js';
import { AmqpEventPublisher, BILLING_EVENTS_EXCHANGE } from './amqp-event-publisher.js';

const message: OutboxMessage = {
  id: '00000000-0000-4000-8000-000000000001',
  eventType: 'OrderPaidV1',
  routingKey: 'order-paid.v1',
  payload: '{"orderId":"o1"}',
  correlationId: 'corr-1',
  createdAt: new Date('2026-10-10T10:00:00.000Z'),
  attempts: 2,
  nextAttemptAt: new Date('2026-10-10T10:00:00.000Z'),
};

describe('AmqpEventPublisher', () => {
  it('publishes the stored payload verbatim to billing.events with the event identity', async () => {
    const sent: OutgoingMessage[] = [];
    const publisher = new AmqpEventPublisher({
      publish: async (m): Promise<PublishResult> => {
        sent.push(m);
        return { kind: 'delivered' };
      },
    });

    expect(await publisher.publish(message)).toEqual({ kind: 'delivered' });
    expect(sent).toEqual([
      {
        exchange: 'billing.events',
        routingKey: 'order-paid.v1',
        messageId: message.id,
        type: 'OrderPaidV1',
        correlationId: 'corr-1',
        body: '{"orderId":"o1"}',
      },
    ]);
    expect(BILLING_EVENTS_EXCHANGE).toBe('billing.events');
  });

  it.each<PublishResult>([{ kind: 'unroutable' }, { kind: 'failed', error: 'no confirm' }])(
    'passes %j through unchanged',
    async (result) => {
      const publisher = new AmqpEventPublisher({ publish: async () => result });
      expect(await publisher.publish(message)).toEqual(result);
    },
  );
});
```

`services/wallet/src/application/relay-outbox.integration.test.ts`:
```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import type { EventPublisher, Logger, NewOutboxMessage, OutboxMessage, PublishOutcome } from './ports.js';
import { RelayOutbox } from './relay-outbox.js';

class ScriptedPublisher implements EventPublisher {
  readonly published: OutboxMessage[] = [];
  readonly script: Array<PublishOutcome | 'throw'> = [];
  onPublish: ((message: OutboxMessage) => Promise<void>) | undefined;

  async publish(message: OutboxMessage): Promise<PublishOutcome> {
    this.published.push(message);
    await this.onPublish?.(message);
    const next = this.script.shift() ?? { kind: 'delivered' };
    if (next === 'throw') throw new Error('publisher blew up');
    return next;
  }
}

let h: Harness;
let publisher: ScriptedPublisher;
let relay: RelayOutbox;
let logs: Array<{ level: string; details: object; message: string | undefined }>;
let counter = 0;
const T0 = '2026-10-10T10:00:00.000Z';

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  for (const schema of ['t_acme', 't_beta']) {
    await h.db.withSchema(schema).updateTable('outbox').set({ status: 'SENT' }).execute();
  }
  h.clock.set(T0);
  logs = [];
  const log: Logger = {
    info: (details, message) => logs.push({ level: 'info', details, message }),
    warn: (details, message) => logs.push({ level: 'warn', details, message }),
    error: (details, message) => logs.push({ level: 'error', details, message }),
  };
  publisher = new ScriptedPublisher();
  relay = new RelayOutbox({ uow: h.uow, publisher, clock: h.clock, log, backoffSeconds: [1, 5] });
});
afterEach(() => undefined);

const enqueue = async (tenant: TenantId = h.acme, createdAt = h.clock.now()): Promise<string> => {
  const id = `00000000-0000-4000-9000-${String(++counter).padStart(12, '0')}`;
  const message: NewOutboxMessage = {
    id,
    eventType: 'OrderPaidV1',
    routingKey: 'order-paid.v1',
    payload: JSON.stringify({ id }),
    correlationId: 'corr-1',
    createdAt,
  };
  await h.uow.run(tenant, ({ outbox }) => outbox.add(message));
  return id;
};
const rowOf = (id: string, tenant: TenantId = h.acme) =>
  h.db.withSchema(`t_${tenant.value}`).selectFrom('outbox').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

describe('RelayOutbox', () => {
  it('publishes the oldest due message first, outside any transaction, and retires it', async () => {
    const second = await enqueue(h.acme, new Date('2026-10-10T09:59:00.000Z'));
    const first = await enqueue(h.acme, new Date('2026-10-10T09:58:00.000Z'));
    h.clock.set('2026-10-10T10:00:05.000Z');

    expect(await relay.executeNextDue(h.acme)).toBe('SENT');
    expect(publisher.published.map((m) => m.id)).toEqual([first]);
    expect(await rowOf(first)).toMatchObject({ status: 'SENT', sent_at: new Date('2026-10-10T10:00:05.000Z') });
    expect((await rowOf(second)).status).toBe('PENDING');
  });

  it('does not hold the row lock while publishing', async () => {
    const id = await enqueue();
    let reachedDuringPublish = false;
    publisher.onPublish = async () => {
      const touched = h.db
        .withSchema('t_acme')
        .updateTable('outbox')
        .set({ correlation_id: 'touched-while-publishing' })
        .where('id', '=', id)
        .execute()
        .then(() => true);
      reachedDuringPublish = await Promise.race([touched, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000))]);
    };
    expect(await relay.executeNextDue(h.acme)).toBe('SENT');
    expect(reachedDuringPublish).toBe(true);
  });

  it('keeps an unroutable message PENDING, backs off by attempt count, caps at the last step, and finally delivers', async () => {
    const id = await enqueue();
    publisher.script.push({ kind: 'unroutable' }, { kind: 'unroutable' }, { kind: 'unroutable' });

    expect(await relay.executeNextDue(h.acme)).toBe('UNROUTABLE');
    expect(await rowOf(id)).toMatchObject({ status: 'PENDING', attempts: 1, next_attempt_at: new Date('2026-10-10T10:00:01.000Z') });
    expect(await relay.executeNextDue(h.acme)).toBeNull();

    h.clock.advanceSeconds(1);
    expect(await relay.executeNextDue(h.acme)).toBe('UNROUTABLE');
    expect(await rowOf(id)).toMatchObject({ attempts: 2, next_attempt_at: new Date('2026-10-10T10:00:06.000Z') });

    h.clock.advanceSeconds(5);
    expect(await relay.executeNextDue(h.acme)).toBe('UNROUTABLE');
    // Hết bậc backoff thì giữ nguyên bậc cuối (5 s), không bao giờ bỏ dòng.
    expect(await rowOf(id)).toMatchObject({ attempts: 3, next_attempt_at: new Date('2026-10-10T10:00:11.000Z') });

    h.clock.advanceSeconds(5);
    expect(await relay.executeNextDue(h.acme)).toBe('SENT');
    expect(await rowOf(id)).toMatchObject({ status: 'SENT' });
    expect(publisher.published.map((m) => m.id)).toEqual([id, id, id, id]);
  });

  it('treats a failed publish and a throwing publisher alike, and logs without leaking the payload', async () => {
    const id = await enqueue();
    publisher.script.push({ kind: 'failed', error: 'channel closed' }, 'throw');
    expect(await relay.executeNextDue(h.acme)).toBe('FAILED');
    h.clock.advanceSeconds(1);
    expect(await relay.executeNextDue(h.acme)).toBe('FAILED');
    expect(await rowOf(id)).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain(`{"id":"${id}"}`);
  });

  it('warns (not errors) when nothing is bound to receive the event', async () => {
    await enqueue();
    publisher.script.push({ kind: 'unroutable' });
    await relay.executeNextDue(h.acme);
    expect(logs.map((l) => l.level)).toEqual(['warn']);
  });

  it('leaves a leased message alone until the lease expires (crash recovery), then sends it again', async () => {
    const id = await enqueue();
    let release: () => void = () => undefined;
    publisher.onPublish = () => new Promise<void>((resolve) => (release = resolve));
    const stuck = relay.executeNextDue(h.acme);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const other = new ScriptedPublisher();
    const second = new RelayOutbox({ uow: h.uow, publisher: other, clock: h.clock, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, backoffSeconds: [1] });
    expect(await second.executeNextDue(h.acme)).toBeNull();
    h.clock.advanceSeconds(61);
    expect(await second.executeNextDue(h.acme)).toBe('SENT');
    expect(other.published.map((m) => m.id)).toEqual([id]);

    release();
    await stuck;
  });

  it('honours the limit and stops claiming once shouldContinue turns false', async () => {
    for (let i = 0; i < 5; i++) await enqueue();
    expect(await relay.execute(h.acme, 2)).toEqual({ sent: 2, unroutable: 0, failed: 0 });
    let sends = 0;
    publisher.onPublish = async () => {
      sends += 1;
    };
    expect(await relay.execute(h.acme, 50, { shouldContinue: () => sends < 1 })).toEqual({ sent: 1, unroutable: 0, failed: 0 });
    expect(await relay.execute(h.acme)).toEqual({ sent: 2, unroutable: 0, failed: 0 });
    expect(await relay.execute(h.acme)).toEqual({ sent: 0, unroutable: 0, failed: 0 });
  });

  it('counts outcomes in the report', async () => {
    for (let i = 0; i < 3; i++) await enqueue();
    publisher.script.push({ kind: 'delivered' }, { kind: 'unroutable' }, { kind: 'failed', error: 'x' });
    expect(await relay.execute(h.acme)).toEqual({ sent: 1, unroutable: 1, failed: 1 });
  });

  it('only touches the given tenant', async () => {
    const inBeta = await enqueue(h.beta);
    await enqueue(h.acme);
    await relay.execute(h.acme);
    expect((await rowOf(inBeta, h.beta)).status).toBe('PENDING');
  });

  it('publishes every message exactly once when two relays run at once', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => enqueue()));
    const other = new ScriptedPublisher();
    const second = new RelayOutbox({ uow: h.uow, publisher: other, clock: h.clock, log: { info: () => undefined, warn: () => undefined, error: () => undefined }, backoffSeconds: [1] });
    await Promise.all([relay.execute(h.acme), second.execute(h.acme)]);
    const sent = [...publisher.published, ...other.published].map((m) => m.id).sort();
    expect(sent).toEqual([...ids].sort());
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet/src/infrastructure/amqp-event-publisher.test.ts` và `corepack pnpm test:integration relay-outbox`
Expected: FAIL (module chưa tồn tại).

- [ ] **Step 4: Cài đặt**

`services/wallet/src/application/relay-outbox.ts`:
```ts
import type { TenantId } from '../domain/tenant-id.js';
import type { Clock, EventPublisher, Logger, PublishOutcome, TenantUnitOfWork } from './ports.js';

export const DEFAULT_OUTBOX_BACKOFF_SECONDS: readonly number[] = [1, 5, 30, 120, 600];

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_BATCH = 50;
const FALLBACK_DELAY_SECONDS = 60;

export type RelayOutcome = 'SENT' | 'UNROUTABLE' | 'FAILED';

export interface RelayReport {
  sent: number;
  unroutable: number;
  failed: number;
}

const plusSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

/**
 * Đẩy outbox ra broker: chiếm MỘT dòng bằng lease trong transaction ngắn, publish NGOÀI transaction, rồi ghi kết quả
 * trong transaction mới. Giao ít nhất một lần (chết giữa publish và `markSent` thì gửi lại sau lease); bên nhận khử
 * trùng theo `eventId`. Không bao giờ bỏ dòng: thất bại chỉ hẹn lại theo backoff.
 */
export class RelayOutbox {
  private readonly leaseSeconds: number;

  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      publisher: EventPublisher;
      clock: Clock;
      log: Logger;
      backoffSeconds: readonly number[];
      leaseSeconds?: number;
    },
  ) {
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  async executeNextDue(tenant: TenantId): Promise<RelayOutcome | null> {
    const claimed = await this.deps.uow.run(tenant, async ({ outbox }) => {
      const now = this.deps.clock.now();
      const message = await outbox.lockNextDue(now);
      if (!message) return null;
      await outbox.lease(message.id, plusSeconds(now, this.leaseSeconds));
      return message;
    });
    if (!claimed) return null;

    let result: PublishOutcome;
    try {
      result = await this.deps.publisher.publish(claimed);
    } catch (error) {
      result = { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }

    const now = this.deps.clock.now();
    const delay =
      this.deps.backoffSeconds[Math.min(claimed.attempts, this.deps.backoffSeconds.length - 1)] ??
      FALLBACK_DELAY_SECONDS;
    await this.deps.uow.run(tenant, async ({ outbox }) => {
      if (result.kind === 'delivered') await outbox.markSent(claimed.id, now);
      else await outbox.recordFailure(claimed.id, plusSeconds(now, delay));
    });

    const details = {
      tenantId: tenant.value,
      eventId: claimed.id,
      eventType: claimed.eventType,
      routingKey: claimed.routingKey,
      attempt: claimed.attempts + 1,
    };
    if (result.kind === 'unroutable') {
      this.deps.log.warn(details, 'no queue is bound to receive the event; will retry');
      return 'UNROUTABLE';
    }
    if (result.kind === 'failed') {
      this.deps.log.error({ ...details, err: result.error }, 'publishing the event failed; will retry');
      return 'FAILED';
    }
    return 'SENT';
  }

  async execute(
    tenant: TenantId,
    limit = DEFAULT_BATCH,
    options: { shouldContinue?: () => boolean } = {},
  ): Promise<RelayReport> {
    const report: RelayReport = { sent: 0, unroutable: 0, failed: 0 };
    for (let i = 0; i < limit; i++) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      const outcome = await this.executeNextDue(tenant);
      if (outcome === null) break;
      if (outcome === 'SENT') report.sent += 1;
      else if (outcome === 'UNROUTABLE') report.unroutable += 1;
      else report.failed += 1;
    }
    return report;
  }
}
```

`services/wallet/src/infrastructure/amqp-event-publisher.ts`:
```ts
import type { ConfirmPublisher } from '@billing/messaging';
import type { EventPublisher, OutboxMessage, PublishOutcome } from '../application/ports.js';

export const BILLING_EVENTS_EXCHANGE = 'billing.events';

/** Adapter của cổng `EventPublisher`: đẩy payload outbox nguyên văn lên exchange `billing.events`. */
export class AmqpEventPublisher implements EventPublisher {
  constructor(private readonly publisher: Pick<ConfirmPublisher, 'publish'>) {}

  publish(message: OutboxMessage): Promise<PublishOutcome> {
    return this.publisher.publish({
      exchange: BILLING_EVENTS_EXCHANGE,
      routingKey: message.routingKey,
      messageId: message.id,
      type: message.eventType,
      correlationId: message.correlationId,
      body: message.payload,
    });
  }
}
```

- [ ] **Step 5: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run services/wallet/src/infrastructure/amqp-event-publisher.test.ts
corepack pnpm test:integration relay-outbox
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS. (Lint: file `infrastructure/amqp-event-publisher.ts` import `@billing/messaging` hợp lệ; `application/` không import nó.)

- [ ] **Step 6: Commit**

```bash
git add -A services/wallet pnpm-lock.yaml
git commit -m "feat(wallet): outbox relay (lease, backoff, never drops) and AMQP event publisher"
```

---

### Task 8: Consumer của wallet — giải mã, tenant, ánh xạ kết quả, topology

**Files:**
- Create: `services/wallet/src/interface/messaging/order-ready.decoder.ts`, `order-ready.handler.ts`, `order-payments.topology.ts`
- Test: `interface/messaging/order-ready.decoder.test.ts`, `order-ready.handler.test.ts`, `order-payments.topology.test.ts`

**Interfaces:**
- Consumes: `validateEvent`, `eventCatalog`, `OrderReadyForPaymentV1` (`@billing/contracts`); `HandlerResult`, `IncomingMessage`, `MessageHandler`, `ConsumerTopology` (`@billing/messaging`); `PayOrder`, `PayOrderOutcome` (Task 6); `TenantRegistry`, `Logger`; `MissingTenantError`, `UnknownTenantError`.
- Produces:
  - `decodeOrderReady(body: Buffer | string): { ok: true; event: OrderReadyForPaymentV1 } | { ok: false; reason: string }` — JSON hỏng hoặc sai schema → `ok: false`
  - `createOrderReadyHandler({ registry, payOrder: Pick<PayOrder, 'execute'>, log }): MessageHandler` — giải mã (lỗi → `reject`); tenant từ `event.tenantId` qua `registry.resolve` (thiếu/lạ → `reject`); gọi `payOrder.execute`; **mọi** kết quả nghiệp vụ (`PAID`, `REPLAYED`, `REJECTED`, `DUPLICATE`) → `ack` sau khi `PayOrder` đã commit; lỗi ném ra từ `PayOrder`/registry (ngoài hai lỗi tenant) được để lan ra để consumer chuyển thành `retry`. Chỉ log `tenantId`, `orderId`, `eventId`, `outcome`, `reason` — không log thân message.
  - `ORDER_PAYMENTS_QUEUE = 'wallet.order-payments'`; `orderPaymentsTopology(retryDelaysSeconds: readonly number[]): ConsumerTopology` = `{ queue: 'wallet.order-payments', workExchange: 'wallet.work', workRoutingKey: 'order-payments', retryExchange: 'wallet.retry', retryDelaysSeconds, bindings: [{ exchange: 'orders.events', routingKey: <routing key của OrderReadyForPaymentV1 trong eventCatalog> }] }`

- [ ] **Step 1: Viết test thất bại**

`services/wallet/src/interface/messaging/order-ready.decoder.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { decodeOrderReady } from './order-ready.decoder.js';

const valid = {
  eventId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  occurredAtUtc: '2026-10-10T10:00:00Z',
  tenantId: 'acme',
  correlationId: 'corr-1',
  orderId: '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11',
  customerId: 'cust-1',
  amount: 150000,
  currency: 'VND',
};

describe('decodeOrderReady', () => {
  it('decodes a valid event from a Buffer or a string and ignores unknown fields', () => {
    for (const body of [JSON.stringify(valid), Buffer.from(JSON.stringify({ ...valid, future: 1 }))]) {
      const result = decodeOrderReady(body);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.orderId).toBe(valid.orderId);
    }
  });

  it('refuses a body that is not JSON', () => {
    expect(decodeOrderReady('{not json')).toEqual({ ok: false, reason: 'body is not valid JSON' });
  });

  it.each([
    ['a non-positive amount', { amount: 0 }],
    ['an unsupported currency', { currency: 'EUR' }],
    ['a missing tenant', { tenantId: undefined }],
    ['a non-uuid order id', { orderId: 'o-1' }],
  ])('refuses %s with a readable reason', (_name, patch) => {
    const result = decodeOrderReady(JSON.stringify({ ...valid, ...patch }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/^schema validation failed: /);
  });

  it('refuses a JSON value that is not an object', () => {
    expect(decodeOrderReady('null').ok).toBe(false);
    expect(decodeOrderReady('[1]').ok).toBe(false);
  });
});
```

`services/wallet/src/interface/messaging/order-payments.topology.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ORDER_PAYMENTS_QUEUE, orderPaymentsTopology } from './order-payments.topology.js';

describe('orderPaymentsTopology', () => {
  it('binds the work queue to orders.events with the routing key of OrderReadyForPaymentV1 and passes the retry tiers', () => {
    expect(orderPaymentsTopology([5, 30, 120])).toEqual({
      queue: 'wallet.order-payments',
      workExchange: 'wallet.work',
      workRoutingKey: 'order-payments',
      retryExchange: 'wallet.retry',
      retryDelaysSeconds: [5, 30, 120],
      bindings: [{ exchange: 'orders.events', routingKey: 'order-ready-for-payment.v1' }],
    });
    expect(ORDER_PAYMENTS_QUEUE).toBe('wallet.order-payments');
  });
});
```

`services/wallet/src/interface/messaging/order-ready.handler.test.ts`:
```ts
import type { IncomingMessage } from '@billing/messaging';
import { describe, expect, it } from 'vitest';
import { MissingTenantError, UnknownTenantError } from '../../application/errors.js';
import type { PayOrderInput, PayOrderOutcome } from '../../application/pay-order.js';
import type { Logger, TenantRegistry } from '../../application/ports.js';
import { TenantId } from '../../domain/tenant-id.js';
import { createOrderReadyHandler } from './order-ready.handler.js';

const acme = TenantId.parse('acme');
const registry: TenantRegistry = {
  resolve: (raw) => {
    if (raw === undefined || raw.trim() === '') throw new MissingTenantError('tenant is required');
    if (raw !== 'acme') throw new UnknownTenantError('unknown tenant');
    return acme;
  },
  all: () => [acme],
};

const event = {
  eventId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  occurredAtUtc: '2026-10-10T10:00:00Z',
  tenantId: 'acme',
  correlationId: 'corr-1',
  orderId: '0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11',
  customerId: 'cust-1',
  amount: 150000,
  currency: 'VND',
};

const message = (body: unknown): IncomingMessage => ({
  body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  messageId: event.eventId,
  type: 'OrderReadyForPaymentV1',
  redelivered: false,
  retryCount: 0,
  headers: {},
});

function setup(outcome: PayOrderOutcome | Error) {
  const calls: PayOrderInput[] = [];
  const logs: Array<{ level: string; details: object }> = [];
  const log: Logger = {
    info: (details) => logs.push({ level: 'info', details }),
    warn: (details) => logs.push({ level: 'warn', details }),
    error: (details) => logs.push({ level: 'error', details }),
  };
  const handler = createOrderReadyHandler({
    registry,
    log,
    payOrder: {
      execute: async (input) => {
        calls.push(input);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  });
  return { handler, calls, logs };
}

describe('createOrderReadyHandler', () => {
  it('maps the event to a PayOrder call and acks', async () => {
    const { handler, calls } = setup({ kind: 'PAID', walletTransactionId: 'tx_1' });
    expect(await handler(message(event))).toEqual({ action: 'ack' });
    expect(calls).toEqual([
      {
        tenant: acme,
        eventId: event.eventId,
        correlationId: 'corr-1',
        orderId: event.orderId,
        customerId: 'cust-1',
        amount: 150000,
        currency: 'VND',
      },
    ]);
  });

  it.each<PayOrderOutcome>([
    { kind: 'PAID', walletTransactionId: 'tx_1' },
    { kind: 'REPLAYED', walletTransactionId: 'tx_1' },
    { kind: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' },
    { kind: 'DUPLICATE' },
  ])('acks the business outcome %j (the result travels by outbox, not by retry)', async (outcome) => {
    const { handler, logs } = setup(outcome);
    expect(await handler(message(event))).toEqual({ action: 'ack' });
    expect(logs[0]).toMatchObject({ level: 'info', details: { tenantId: 'acme', orderId: event.orderId, outcome: outcome.kind } });
  });

  it.each([
    ['not JSON', '{oops'],
    ['schema-invalid', { ...event, amount: 0 }],
  ])('rejects a message that is %s without calling PayOrder', async (_name, body) => {
    const { handler, calls, logs } = setup({ kind: 'DUPLICATE' });
    const result = await handler(message(body));
    expect(result.action).toBe('reject');
    expect(calls).toHaveLength(0);
    expect(logs.some((l) => l.level === 'error')).toBe(true);
  });

  it.each(['ghost', 'Acme', "acme'; drop table"])('rejects tenant %j that the service does not host', async (tenantId) => {
    const { handler, calls } = setup({ kind: 'DUPLICATE' });
    expect((await handler(message({ ...event, tenantId }))).action).toBe('reject');
    expect(calls).toHaveLength(0);
  });

  it('lets an infrastructure failure propagate so the consumer retries', async () => {
    const { handler } = setup(new Error('connection lost'));
    await expect(handler(message(event))).rejects.toThrow('connection lost');
  });

  it('never logs the raw message body', async () => {
    const { handler, logs } = setup({ kind: 'PAID', walletTransactionId: 'tx_1' });
    await handler(message(event));
    expect(JSON.stringify(logs)).not.toContain('cust-1');
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet/src/interface/messaging`
Expected: FAIL (các module chưa tồn tại).

- [ ] **Step 3: Cài đặt**

`services/wallet/src/interface/messaging/order-ready.decoder.ts`:
```ts
import { validateEvent, type OrderReadyForPaymentV1 } from '@billing/contracts';

export type DecodeResult =
  | { ok: true; event: OrderReadyForPaymentV1 }
  | { ok: false; reason: string };

/** Biến thân message thành `OrderReadyForPaymentV1` đã kiểm schema; trường lạ được bỏ qua (tolerant reader). */
export function decodeOrderReady(body: Buffer | string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
  } catch {
    return { ok: false, reason: 'body is not valid JSON' };
  }
  const result = validateEvent('OrderReadyForPaymentV1', json);
  if (!result.ok) {
    return { ok: false, reason: `schema validation failed: ${result.errors.join('; ')}` };
  }
  return { ok: true, event: result.event };
}
```

`services/wallet/src/interface/messaging/order-payments.topology.ts`:
```ts
import { eventCatalog } from '@billing/contracts';
import type { ConsumerTopology } from '@billing/messaging';

export const ORDER_PAYMENTS_QUEUE = 'wallet.order-payments';

/** Topology của consumer `OrderReadyForPaymentV1`; xem spec Bước 4 mục 3. Không dùng default exchange. */
export function orderPaymentsTopology(retryDelaysSeconds: readonly number[]): ConsumerTopology {
  return {
    queue: ORDER_PAYMENTS_QUEUE,
    workExchange: 'wallet.work',
    workRoutingKey: 'order-payments',
    retryExchange: 'wallet.retry',
    retryDelaysSeconds,
    bindings: [
      { exchange: 'orders.events', routingKey: eventCatalog.OrderReadyForPaymentV1.routingKey },
    ],
  };
}
```

`services/wallet/src/interface/messaging/order-ready.handler.ts`:
```ts
import type { HandlerResult, IncomingMessage, MessageHandler } from '@billing/messaging';
import { MissingTenantError, UnknownTenantError } from '../../application/errors.js';
import type { PayOrder } from '../../application/pay-order.js';
import type { Logger, TenantRegistry } from '../../application/ports.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { decodeOrderReady } from './order-ready.decoder.js';

/**
 * Ánh xạ một message `OrderReadyForPaymentV1` sang `PayOrder`. Kết quả nghiệp vụ (kể cả từ chối) luôn `ack` vì kết quả
 * đã nằm trong outbox cùng transaction; message hỏng hoặc tenant lạ không bao giờ thành công khi thử lại nên `reject`
 * (vào DLQ); lỗi hạ tầng được để lan ra để consumer chuyển thành `retry`.
 */
export function createOrderReadyHandler(deps: {
  registry: TenantRegistry;
  payOrder: Pick<PayOrder, 'execute'>;
  log: Logger;
}): MessageHandler {
  return async (message: IncomingMessage): Promise<HandlerResult> => {
    const decoded = decodeOrderReady(message.body);
    if (!decoded.ok) {
      deps.log.error(
        { messageId: message.messageId, reason: decoded.reason },
        'rejecting unreadable order-ready message',
      );
      return { action: 'reject', reason: decoded.reason };
    }
    const { event } = decoded;

    let tenant: TenantId;
    try {
      tenant = deps.registry.resolve(event.tenantId);
    } catch (error) {
      if (error instanceof MissingTenantError || error instanceof UnknownTenantError) {
        deps.log.error(
          { messageId: message.messageId, eventId: event.eventId, orderId: event.orderId },
          'rejecting order-ready message for a tenant this service does not host',
        );
        return { action: 'reject', reason: 'unknown tenant' };
      }
      throw error;
    }

    const outcome = await deps.payOrder.execute({
      tenant,
      eventId: event.eventId,
      correlationId: event.correlationId,
      orderId: event.orderId,
      customerId: event.customerId,
      amount: event.amount,
      currency: event.currency,
    });
    deps.log.info(
      {
        tenantId: tenant.value,
        orderId: event.orderId,
        eventId: event.eventId,
        outcome: outcome.kind,
        ...(outcome.kind === 'REJECTED' ? { reason: outcome.reason } : {}),
      },
      'order payment handled',
    );
    return { action: 'ack' };
  };
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run services/wallet/src/interface/messaging
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS. (Lint: các file này thuộc `interface/` và chỉ import `application/`, `domain/`, `@billing/*`.)

- [ ] **Step 5: Commit**

```bash
git add -A services/wallet
git commit -m "feat(wallet): order-ready message decoder, handler and consumer topology"
```

---

### Task 9: Cấu hình, nối dây `bootstrap`, e2e cấp service với RabbitMQ thật và "orders giả"

**Files:**
- Modify: `services/wallet/src/config.ts`, `config.test.ts`, `bootstrap.ts` (viết lại), `test-support.ts`, `service.integration.test.ts`, `env-example.test.ts`, `services/wallet/.env.example`, `tests/e2e/billing.integration.test.ts`
- Create: `services/wallet/src/test-support-orders.ts`, `services/wallet/src/order-payment.integration.test.ts`

**Interfaces:**
- Consumes: `BrokerClient`, `BrokerConfig` (`@billing/messaging`); `PayOrder`, `RelayOutbox`, `DEFAULT_OUTBOX_BACKOFF_SECONDS`, `AmqpEventPublisher`, `createOrderReadyHandler`, `orderPaymentsTopology` (Task 6–8); `createTestBroker`, `FakePaymentServer`, `waitFor` (`@billing/testing`).
- Produces:
  - `WalletConfig` có thêm `broker: BrokerConfig` và `orders: { prefetch: number; retryDelaysSeconds: number[]; outboxBatch: number }`. `loadConfig` đọc `RABBITMQ_HOST`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD` (bắt buộc), `RABBITMQ_PORT` (mặc định 5672, 1..65535), `RABBITMQ_VHOST` (mặc định `billing`), `ORDER_CONSUMER_PREFETCH` (mặc định 10, 1..1000), `ORDER_RETRY_DELAYS` (mặc định `5,30,120`, danh sách số nguyên dương), `OUTBOX_BATCH` (mặc định 50, 1..1000). Thứ tự `problems`: …, `PAYMENT_WEBHOOK_SECRET`, `RABBITMQ_HOST`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `RABBITMQ_PORT`, `TOPUP_SUBMIT_BACKOFF`, `ORDER_RETRY_DELAYS`, `PORT`, `PAYMENT_TIMEOUT_MS`, `ORDER_CONSUMER_PREFETCH`, `OUTBOX_BATCH`, `WORKER_INTERVAL_MS`.
  - `startService(config, overrides)` với `StartOverrides.afterOrderHandled?: () => Promise<void>` (móc cho test: chạy sau khi `PayOrder` đã commit, trước khi trả ack — mô phỏng consumer chết giữa chừng). Thứ tự khởi động: `assertMigrated` → kết nối broker (`initialMaxRetries: 3`) → bật consumer (topology) → `createApp` → worker (nạp tiền + relay outbox theo từng tenant, lỗi một tenant không chặn tenant khác). Thứ tự dừng: `broker.stopConsuming()` → `worker.stop()` → `app.close()` → `submitter.drain()` → `broker.close()` → `db.destroy()` (luôn chạy hết, ném lại lỗi đầu tiên). Lỗi khi khởi động thì đóng broker và pool DB rồi ném.
  - `Harness.config: DatabaseConfig` (cấu hình kết nối của DB test) trong `test-support.ts`.
  - `test-support-orders.ts`: `OrdersSimulator` (đóng vai ecommerce bằng user `ecommerce_orders`): `static connect(access: BrokerAccess, options?: { bindResults?: boolean })`, `bindResults()` (khai báo queue `ecommerce.order-results` gắn vào `billing.events` với hai routing key kết quả rồi đọc), `ready(overrides?)` (dựng `OrderReadyForPaymentV1` hợp lệ), `publish(event)`, `publishRaw(body, messageId?)`, `results: OrderResult[]`, `waitForResults(count, timeoutMs?)`, `resultsFor(orderId)`, `close()`; cùng hàm `queueDepth(access, queue)` và `peekQueue(access, queue)`.

- [ ] **Step 1: Viết test thất bại — cấu hình**

Trong `services/wallet/src/config.test.ts`:
- thêm vào `minimal`: `RABBITMQ_HOST: 'mq', RABBITMQ_USER: 'billing_wallet', RABBITMQ_PASSWORD: 'mq-secret',`
- trong ca "applies the documented defaults" thêm vào `toMatchObject`: `broker: { host: 'mq', port: 5672, vhost: 'billing', user: 'billing_wallet', password: 'mq-secret' }, orders: { prefetch: 10, retryDelaysSeconds: [5, 30, 120], outboxBatch: 50 },`
- ca "refuses to start without the required settings…" thêm ba dòng sau `'PAYMENT_WEBHOOK_SECRET is required'`: `'RABBITMQ_HOST is required', 'RABBITMQ_USER is required', 'RABBITMQ_PASSWORD is required',`
- thêm các ca (trong `describe('loadConfig')`):
```ts
  it('reads the broker and order-consumer overrides', () => {
    const config = loadConfig({
      ...minimal,
      RABBITMQ_PORT: '5673',
      RABBITMQ_VHOST: 'other',
      ORDER_CONSUMER_PREFETCH: '3',
      ORDER_RETRY_DELAYS: '2, 4',
      OUTBOX_BATCH: '7',
    });
    expect(config).toMatchObject({
      broker: { port: 5673, vhost: 'other' },
      orders: { prefetch: 3, retryDelaysSeconds: [2, 4], outboxBatch: 7 },
    });
  });

  it('never has a default for the broker password and treats blank as missing', () => {
    expect(problemsOf({ ...minimal, RABBITMQ_PASSWORD: ' ' })).toEqual(['RABBITMQ_PASSWORD is required']);
  });

  it.each([
    ['RABBITMQ_PORT', '0'],
    ['RABBITMQ_PORT', 'abc'],
    ['ORDER_CONSUMER_PREFETCH', '0'],
    ['ORDER_CONSUMER_PREFETCH', '1001'],
    ['OUTBOX_BATCH', '0'],
    ['OUTBOX_BATCH', 'x'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf({ ...minimal, [name]: value })).toEqual([expect.stringContaining(`${name} must be an integer`)]);
  });

  it.each(['1,a', '0', '-1', '1.5', '1,,2'])('rejects ORDER_RETRY_DELAYS %j', (value) => {
    expect(problemsOf({ ...minimal, ORDER_RETRY_DELAYS: value })).toEqual([
      'ORDER_RETRY_DELAYS must be a comma-separated list of positive integers (seconds)',
    ]);
  });

  it('rejects an empty RABBITMQ_VHOST override', () => {
    expect(loadConfig({ ...minimal, RABBITMQ_VHOST: '  ' }).broker.vhost).toBe('billing');
  });
```

`.env.example`: thêm vào nhóm bắt buộc/tùy chọn:
```
# RabbitMQ dùng chung (vhost billing). User billing_wallet do deploy/scripts/init-rabbitmq.sh tạo; không có mật khẩu mặc định
RABBITMQ_HOST=
RABBITMQ_PORT=5672
RABBITMQ_VHOST=billing
RABBITMQ_USER=billing_wallet
RABBITMQ_PASSWORD=
```
(ngay sau khối `PAYMENT_*`) và thêm ba dòng cuối nhóm tùy chọn: `ORDER_CONSUMER_PREFETCH=10`, `ORDER_RETRY_DELAYS=5,30,120`, `OUTBOX_BATCH=50`.

`env-example.test.ts`: thêm 8 khóa mới vào danh sách kỳ vọng (`ORDER_CONSUMER_PREFETCH`, `ORDER_RETRY_DELAYS`, `OUTBOX_BATCH`, `RABBITMQ_HOST`, `RABBITMQ_PASSWORD`, `RABBITMQ_PORT`, `RABBITMQ_USER`, `RABBITMQ_VHOST`, giữ sắp xếp chữ cái); thêm vào `filledRequired`: `RABBITMQ_HOST: 'mq', RABBITMQ_PASSWORD: 'mq-secret',`; thêm vào `onlyRequired`: `RABBITMQ_HOST: 'mq', RABBITMQ_USER: example.RABBITMQ_USER ?? '', RABBITMQ_PASSWORD: 'mq-secret',`.

- [ ] **Step 2: Cài đặt cấu hình**

`services/wallet/src/config.ts`: thêm import `import type { BrokerConfig } from '@billing/messaging';`; trong `WalletConfig` thêm
```ts
  broker: BrokerConfig;
  orders: { prefetch: number; retryDelaysSeconds: number[]; outboxBatch: number };
```
thêm hằng `const DEFAULT_ORDER_RETRY_DELAYS = '5,30,120';`. Ngay sau dòng `const webhookSecret = required('PAYMENT_WEBHOOK_SECRET');` chèn:
```ts
  // RabbitMQ
  const brokerHost = required('RABBITMQ_HOST');
  const brokerUser = required('RABBITMQ_USER');
  const brokerPassword = required('RABBITMQ_PASSWORD');
  const brokerPort = integer('RABBITMQ_PORT', 5672, 1, 65535);
  const rawVhost = env.RABBITMQ_VHOST;
  const brokerVhost = rawVhost === undefined || rawVhost.trim() === '' ? 'billing' : rawVhost.trim();
```
Ngay sau khối kiểm `topupBackoffSeconds` (sau `if (topupBackoffSeconds === undefined) {…}`) chèn:
```ts
  const rawRetryDelays = env.ORDER_RETRY_DELAYS;
  const retryText =
    rawRetryDelays === undefined || rawRetryDelays.trim() === ''
      ? DEFAULT_ORDER_RETRY_DELAYS
      : rawRetryDelays;
  const retryParts = retryText.split(',').map((part) => part.trim());
  const retryDelaysSeconds = retryParts.every((part) => /^[1-9]\d{0,5}$/.test(part))
    ? retryParts.map(Number)
    : undefined;
  if (retryDelaysSeconds === undefined) {
    problems.push('ORDER_RETRY_DELAYS must be a comma-separated list of positive integers (seconds)');
  }
```
Thay hai dòng `const timeoutMs …` / `const workerIntervalMs …` thành (giữ nguyên `port` và `timeoutMs`, thêm hai dòng giữa):
```ts
  const timeoutMs = integer('PAYMENT_TIMEOUT_MS', 5000, 1, 50_000);
  const prefetch = integer('ORDER_CONSUMER_PREFETCH', 10, 1, 1000);
  const outboxBatch = integer('OUTBOX_BATCH', 50, 1, 1000);
  const workerIntervalMs = integer('WORKER_INTERVAL_MS', 500, 1, 3_600_000);
```
Sửa điều kiện ném và giá trị trả về:
```ts
  if (
    problems.length > 0 ||
    database === undefined ||
    topupBackoffSeconds === undefined ||
    retryDelaysSeconds === undefined
  ) {
    throw new ConfigError(problems);
  }
  return {
    port,
    database,
    tenants,
    payment: { baseUrl, webhookSecret, timeoutMs },
    broker: { host: brokerHost, port: brokerPort, vhost: brokerVhost, user: brokerUser, password: brokerPassword },
    orders: { prefetch, retryDelaysSeconds, outboxBatch },
    topupBackoffSeconds,
    workerIntervalMs,
  };
```
Chạy: `corepack pnpm exec vitest run services/wallet/src/config.test.ts services/wallet/src/env-example.test.ts` — Expected: PASS.

- [ ] **Step 3: Viết hỗ trợ test và test e2e thất bại**

Trong `services/wallet/src/test-support.ts`: thêm `import type { DatabaseConfig } from '@billing/database';` (gộp vào import `createDatabase` hiện có), thêm `config: DatabaseConfig;` vào `Harness` và `config: testDb.config,` vào object trả về của `createHarness`.

`services/wallet/src/test-support-orders.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { OrderReadyForPaymentV1 } from '@billing/contracts';
import { waitFor, type BrokerAccess } from '@billing/testing';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';

export interface OrderResult {
  type: string | undefined;
  messageId: string | undefined;
  body: Record<string, unknown>;
}

const connect = (access: BrokerAccess): Promise<ChannelModel> =>
  amqp.connect({
    protocol: 'amqp',
    hostname: access.host,
    port: access.port,
    username: access.user,
    password: access.password,
    vhost: access.vhost,
  });

export async function queueDepth(access: BrokerAccess, queue: string): Promise<number> {
  const connection = await connect(access);
  try {
    const channel = await connection.createChannel();
    return (await channel.checkQueue(queue)).messageCount;
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Đọc (không ack) message đầu của một queue để kiểm tra nội dung và header. */
export async function peekQueue(
  access: BrokerAccess,
  queue: string,
): Promise<{ body: string; headers: Record<string, unknown>; messageId: string | undefined } | null> {
  const connection = await connect(access);
  try {
    const channel = await connection.createChannel();
    const message = await channel.get(queue, { noAck: true });
    if (message === false) return null;
    return {
      body: message.content.toString('utf8'),
      headers: message.properties.headers ?? {},
      messageId: message.properties.messageId,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Đóng vai ecommerce: publish OrderReadyForPaymentV1 vào orders.events và đọc kết quả từ billing.events. */
export class OrdersSimulator {
  readonly results: OrderResult[] = [];

  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
  ) {}

  static async connect(access: BrokerAccess, options: { bindResults?: boolean } = {}): Promise<OrdersSimulator> {
    const connection = await connect(access);
    const channel = await connection.createConfirmChannel();
    const simulator = new OrdersSimulator(connection, channel);
    if (options.bindResults ?? true) await simulator.bindResults();
    return simulator;
  }

  /** Ecommerce khai báo queue của họ (tiền tố `ecommerce.`) gắn vào billing.events rồi bắt đầu đọc. */
  async bindResults(): Promise<void> {
    await this.channel.assertQueue('ecommerce.order-results', { durable: true });
    for (const key of ['order-paid.v1', 'order-payment-failed.v1']) {
      await this.channel.bindQueue('ecommerce.order-results', 'billing.events', key);
    }
    await this.channel.consume('ecommerce.order-results', (message) => {
      if (message === null) return;
      this.results.push({
        type: message.properties.type,
        messageId: message.properties.messageId,
        body: JSON.parse(message.content.toString('utf8')) as Record<string, unknown>,
      });
      this.channel.ack(message);
    });
  }

  ready(overrides: Partial<OrderReadyForPaymentV1> = {}): OrderReadyForPaymentV1 {
    return {
      eventId: randomUUID(),
      occurredAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      correlationId: randomUUID(),
      orderId: randomUUID(),
      customerId: 'customer',
      amount: 50000,
      currency: 'VND',
      ...overrides,
    };
  }

  publish(event: OrderReadyForPaymentV1): Promise<void> {
    return this.publishRaw(JSON.stringify(event), event.eventId);
  }

  publishRaw(body: string, messageId: string = randomUUID(), routingKey = 'order-ready-for-payment.v1'): Promise<void> {
    return new Promise((resolve, reject) =>
      this.channel.publish(
        'orders.events',
        routingKey,
        Buffer.from(body),
        {
          persistent: true,
          contentType: 'application/json',
          messageId,
          type: 'OrderReadyForPaymentV1',
          headers: { 'x-correlation-id': 'simulator' },
        },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }

  resultsFor(orderId: string): OrderResult[] {
    return this.results.filter((result) => result.body.orderId === orderId);
  }

  async waitForResults(count: number, timeoutMs = 15_000): Promise<void> {
    await waitFor(() => this.results.length >= count, { timeoutMs, intervalMs: 50 });
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => undefined);
  }
}
```
(Thêm `amqplib` làm devDependency của wallet: `corepack pnpm --filter @billing/wallet-service add -D amqplib@^2.2.0`.)

`services/wallet/src/order-payment.integration.test.ts`:
```ts
import { validateEvent } from '@billing/contracts';
import { FakePaymentServer, createTestBroker, waitFor, type TestBroker } from '@billing/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type RunningService, type StartOverrides } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import { createHarness, fundWallet, type Harness } from './test-support.js';
import { OrdersSimulator, peekQueue, queueDepth } from './test-support-orders.js';

let h: Harness;
let payment: FakePaymentServer;
let counter = 0;
const DLQ = 'wallet.order-payments.dlq';

beforeAll(async () => {
  h = await createHarness();
  payment = await FakePaymentServer.start();
});
afterAll(async () => {
  await payment.close();
  await h.close();
});

const configFor = (broker: TestBroker): WalletConfig => ({
  port: 0,
  database: h.config,
  tenants: [h.acme, h.beta],
  payment: { baseUrl: payment.baseUrl, webhookSecret: 'whsec_orders_e2e', timeoutMs: 1000 },
  broker: broker.wallet,
  orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
  topupBackoffSeconds: [1],
  workerIntervalMs: 50,
});

interface Stack {
  broker: TestBroker;
  service: RunningService;
  orders: OrdersSimulator;
  stop(): Promise<void>;
}

async function startStack(overrides: StartOverrides = {}, options: { bindResults?: boolean } = {}): Promise<Stack> {
  const broker = await createTestBroker('orders');
  const orders = await OrdersSimulator.connect(broker.ecommerce, options);
  const service = await startService(configFor(broker), overrides);
  return {
    broker,
    service,
    orders,
    async stop() {
      await service.stop();
      await orders.close();
      await broker.drop();
    },
  };
}

const newCustomer = () => `oc${++counter}`;
const balance = async (customer: string, tenant = 'acme'): Promise<number> =>
  Number(
    (await h.db.withSchema(`t_${tenant}`).selectFrom('accounts').select('balance').where('id', '=', `wallet:${customer}`).executeTakeFirstOrThrow()).balance,
  );
const ledgerCount = async (orderId: string, tenant = 'acme'): Promise<number> =>
  (await h.db.withSchema(`t_${tenant}`).selectFrom('ledger_transactions').select('id').where('business_key', '=', `order:${orderId}`).execute()).length;
const quiet = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));

describe('order payment over RabbitMQ (wallet + simulated orders)', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(async () => {
    await stack.stop();
  });

  it('pays an order from the wallet and reports OrderPaidV1 with the ledger transaction id', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 40000 });

    await stack.orders.publish(event);
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, { timeoutMs: 15_000 });

    const [result] = stack.orders.resultsFor(event.orderId);
    expect(result?.type).toBe('OrderPaidV1');
    expect(validateEvent('OrderPaidV1', result?.body).ok).toBe(true);
    expect(result?.messageId).toBe(result?.body.eventId);
    expect(result?.body).toMatchObject({ orderId: event.orderId, amount: 40000, currency: 'VND', tenantId: 'acme', correlationId: event.correlationId });
    expect(await balance(customer)).toBe(60000);

    const entries = await stack.service.app.inject({
      method: 'GET',
      url: '/wallet/entries',
      headers: { 'x-tenant-id': 'acme', 'x-customer-id': customer },
    });
    expect(entries.json<{ items: Array<{ businessKey: string; amount: number; transactionId: string }> }>().items).toContainEqual(
      expect.objectContaining({ businessKey: `order:${event.orderId}`, amount: -40000, transactionId: result?.body.walletTransactionId }),
    );
  });

  it.each([
    ['INSUFFICIENT_FUNDS', async (c: string) => stack.orders.ready({ customerId: c, amount: 999999 }), true],
    ['WALLET_NOT_FOUND', async () => stack.orders.ready({ customerId: 'nobody-has-this' }), false],
    ['CURRENCY_MISMATCH', async (c: string) => stack.orders.ready({ customerId: c, currency: 'USD', amount: 10 }), true],
  ])('reports OrderPaymentFailedV1(%s) and leaves the wallet untouched', async (reason, make, funded) => {
    const customer = newCustomer();
    if (funded) await fundWallet(h, { customer, amount: 100000 });
    const event = await make(customer);
    await stack.orders.publish(event);
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, { timeoutMs: 15_000 });
    const [result] = stack.orders.resultsFor(event.orderId);
    expect(result?.type).toBe('OrderPaymentFailedV1');
    expect(validateEvent('OrderPaymentFailedV1', result?.body).ok).toBe(true);
    expect(result?.body.reason).toBe(reason);
    if (funded) expect(await balance(customer)).toBe(100000);
  });

  it('lets a refused order be paid after the customer tops up (a refusal is not remembered)', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 1000 });
    const first = stack.orders.ready({ customerId: customer, amount: 5000 });
    await stack.orders.publish(first);
    await waitFor(() => stack.orders.resultsFor(first.orderId).length === 1, { timeoutMs: 15_000 });
    expect(stack.orders.resultsFor(first.orderId)[0]?.type).toBe('OrderPaymentFailedV1');

    await fundWallet(h, { customer, amount: 10000 });
    await stack.orders.publish({ ...first, eventId: stack.orders.ready().eventId });
    await waitFor(() => stack.orders.resultsFor(first.orderId).length === 2, { timeoutMs: 15_000 });
    expect(stack.orders.resultsFor(first.orderId)[1]?.type).toBe('OrderPaidV1');
    expect(await balance(customer)).toBe(6000);
  });

  it('charges once when the broker delivers the same event again, and says nothing the second time', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 30000 });
    await stack.orders.publish(event);
    await stack.orders.publish(event);
    await waitFor(() => stack.orders.resultsFor(event.orderId).length >= 1, { timeoutMs: 15_000 });
    await quiet();
    expect(stack.orders.resultsFor(event.orderId)).toHaveLength(1);
    expect(await balance(customer)).toBe(70000);
    expect(await ledgerCount(event.orderId)).toBe(1);
  });

  it('replays OrderPaidV1 with the same wallet transaction when the order is requested again under a new event id', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 30000 });
    await stack.orders.publish(event);
    await stack.orders.publish({ ...event, eventId: stack.orders.ready().eventId });
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 2, { timeoutMs: 15_000 });
    const [a, b] = stack.orders.resultsFor(event.orderId);
    expect(a?.body.walletTransactionId).toBe(b?.body.walletTransactionId);
    expect(a?.body.eventId).not.toBe(b?.body.eventId);
    expect(await balance(customer)).toBe(70000);
    expect(await ledgerCount(event.orderId)).toBe(1);
  });

  it('refuses a conflicting repeat (same order, different amount) with CONFLICT and does not charge again', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 30000 });
    await stack.orders.publish(event);
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, { timeoutMs: 15_000 });
    await stack.orders.publish({ ...event, eventId: stack.orders.ready().eventId, amount: 31000 });
    await waitFor(() => stack.orders.resultsFor(event.orderId).length === 2, { timeoutMs: 15_000 });
    expect(stack.orders.resultsFor(event.orderId)[1]?.body.reason).toBe('CONFLICT');
    expect(await balance(customer)).toBe(70000);
  });

  it('charges exactly once when the same event is published twenty times at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const event = stack.orders.ready({ customerId: customer, amount: 20000 });
    await Promise.all(Array.from({ length: 20 }, () => stack.orders.publish(event)));
    await waitFor(() => stack.orders.resultsFor(event.orderId).length >= 1, { timeoutMs: 20_000 });
    await quiet(2500);
    expect(stack.orders.resultsFor(event.orderId)).toHaveLength(1);
    expect(await balance(customer)).toBe(80000);
    expect(await ledgerCount(event.orderId)).toBe(1);
  });

  it('charges exactly once when the same order arrives under ten different event ids at once', async () => {
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 100000 });
    const base = stack.orders.ready({ customerId: customer, amount: 20000 });
    await Promise.all(Array.from({ length: 10 }, () => stack.orders.publish({ ...base, eventId: stack.orders.ready().eventId })));
    await waitFor(() => stack.orders.resultsFor(base.orderId).length === 10, { timeoutMs: 30_000 });
    const transactions = new Set(stack.orders.resultsFor(base.orderId).map((r) => r.body.walletTransactionId));
    expect(transactions.size).toBe(1);
    expect(await balance(customer)).toBe(80000);
    expect(await ledgerCount(base.orderId)).toBe(1);
  });

  it('dead-letters unreadable, schema-invalid and unknown-tenant messages without touching any wallet', async () => {
    const before = await queueDepth(stack.broker.admin, DLQ);
    const customer = newCustomer();
    await fundWallet(h, { customer, amount: 5000 });
    await stack.orders.publishRaw('{this is not json');
    await stack.orders.publish(stack.orders.ready({ customerId: customer, amount: 0 }));
    await stack.orders.publish(stack.orders.ready({ customerId: customer, tenantId: 'ghost' }));
    await waitFor(async () => (await queueDepth(stack.broker.admin, DLQ)) === before + 3, { timeoutMs: 15_000 });
    expect(await balance(customer)).toBe(5000);
    const dead = await peekQueue(stack.broker.admin, DLQ);
    expect(String(dead?.headers['x-dead-letter-reason'] ?? '')).not.toBe('');
  });
});

describe('order payment — failure modes', () => {
  it('does not lose the result when nobody is bound to receive it yet: the outbox retries until the consumer queue exists', async () => {
    const stack = await startStack({}, { bindResults: false });
    try {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 100000 });
      const event = stack.orders.ready({ customerId: customer, amount: 25000 });
      await stack.orders.publish(event);

      await waitFor(
        async () => {
          const rows = await h.db.withSchema('t_acme').selectFrom('outbox').select(['attempts', 'status']).where('payload', 'like', `%${event.orderId}%`).execute();
          return rows.length === 1 && rows[0]!.status === 'PENDING' && rows[0]!.attempts >= 1;
        },
        { timeoutMs: 15_000 },
      );
      expect(stack.orders.results).toHaveLength(0);

      await stack.orders.bindResults();
      await waitFor(() => stack.orders.resultsFor(event.orderId).length === 1, { timeoutMs: 30_000 });
      expect(stack.orders.resultsFor(event.orderId)[0]?.type).toBe('OrderPaidV1');
      expect(await balance(customer)).toBe(75000);
    } finally {
      await stack.stop();
    }
  });

  it('survives a consumer that dies after the payment committed but before it acknowledged', async () => {
    let killed = false;
    let broker: TestBroker | undefined;
    const stack = await startStack({
      afterOrderHandled: async () => {
        if (killed || !broker) return;
        killed = true;
        await broker.closeConnections({ user: 'billing_wallet' });
      },
    });
    broker = stack.broker;
    try {
      const customer = newCustomer();
      await fundWallet(h, { customer, amount: 100000 });
      const event = stack.orders.ready({ customerId: customer, amount: 45000 });
      await stack.orders.publish(event);

      await waitFor(() => stack.orders.resultsFor(event.orderId).length >= 1, { timeoutMs: 60_000, intervalMs: 200 });
      await quiet(2500);
      expect(killed).toBe(true);
      expect(stack.orders.resultsFor(event.orderId)).toHaveLength(1);
      expect(await balance(customer)).toBe(55000);
      expect(await ledgerCount(event.orderId)).toBe(1);
    } finally {
      await stack.stop();
    }
  }, 90_000);

  it('refuses to start when the broker vhost does not exist, and releases what it had opened', async () => {
    const broker = await createTestBroker('orders');
    try {
      await expect(
        startService({ ...configFor(broker), broker: { ...broker.wallet, vhost: 'no-such-vhost' } }),
      ).rejects.toThrow();
    } finally {
      await broker.drop();
    }
  }, 60_000);
});
```

Cập nhật `services/wallet/src/service.integration.test.ts`: thêm biến `broker: TestBroker`, `await createTestBroker('walletsvc')` trong `beforeAll` (và `await broker.drop()` trong `afterAll`, import `createTestBroker`, `type TestBroker` từ `@billing/testing`), và trong `configFor` thêm `broker: broker.wallet, orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },`. Ca "refuses to start when a configured tenant has not been migrated" dùng `configFor()` nên tự nhận. Trong `tests/e2e/billing.integration.test.ts`: import thêm `createTestBroker`, `type TestBroker`; khai báo `let broker: TestBroker;`; trong `beforeAll` trước khi `startWallet` thêm `broker = await createTestBroker('e2e');` và truyền `broker: broker.wallet, orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },` vào cấu hình wallet; trong `afterAll` thêm `await broker?.drop();`.

- [ ] **Step 4: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration order-payment`
Expected: FAIL (`startService` chưa nhận `broker`, `afterOrderHandled`…).

- [ ] **Step 5: Cài đặt `bootstrap.ts`**

Thay toàn bộ `services/wallet/src/bootstrap.ts`:
```ts
import { createDatabase } from '@billing/database';
import { BrokerClient } from '@billing/messaging';
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
import { PayOrder } from './application/pay-order.js';
import type { Clock, IdGenerator, Logger } from './application/ports.js';
import { DEFAULT_OUTBOX_BACKOFF_SECONDS, RelayOutbox } from './application/relay-outbox.js';
import { RequestTopup } from './application/request-topup.js';
import { SubmitDueTopups } from './application/submit-due-topups.js';
import { SubmitTopup } from './application/submit-topup.js';
import type { WalletConfig } from './config.js';
import { AmqpEventPublisher } from './infrastructure/amqp-event-publisher.js';
import { HttpPaymentGateway } from './infrastructure/http-payment-gateway.js';
import { assertMigrated } from './infrastructure/kysely/provisioning.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';
import { KyselyTenantUnitOfWork } from './infrastructure/kysely/unit-of-work.js';
import { RandomIdGenerator, SystemClock } from './infrastructure/system.js';
import { ConfigTenantRegistry } from './infrastructure/tenant-registry.js';
import { createApp } from './interface/http/create-app.js';
import { createOrderReadyHandler } from './interface/messaging/order-ready.handler.js';
import { orderPaymentsTopology } from './interface/messaging/order-payments.topology.js';

export interface StartOverrides {
  clock?: Clock;
  ids?: IdGenerator;
  /** Móc cho test: chạy sau khi PayOrder đã commit, trước khi trả ack cho broker (mô phỏng consumer chết giữa chừng). */
  afterOrderHandled?: () => Promise<void>;
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

  let broker: BrokerClient;
  try {
    broker = await BrokerClient.connect({ config: config.broker, log, initialMaxRetries: 3 });
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
    log,
    backoffSeconds: config.topupBackoffSeconds,
  });
  const submitter = new InlineTopupSubmitter({ submit, log });
  const submitDue = new SubmitDueTopups({ submit });

  const payOrder = new PayOrder({ uow, clock, ids, log });
  const relay = new RelayOutbox({
    uow,
    publisher: new AmqpEventPublisher(broker.publisher),
    clock,
    log,
    backoffSeconds: DEFAULT_OUTBOX_BACKOFF_SECONDS,
  });
  const orderReady = createOrderReadyHandler({ registry, payOrder, log });

  let app: NestFastifyApplication;
  try {
    await broker.consume({
      topology: orderPaymentsTopology(config.orders.retryDelaysSeconds),
      prefetch: config.orders.prefetch,
      handler: async (message) => {
        const result = await orderReady(message);
        await overrides.afterOrderHandled?.();
        return result;
      },
    });
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
    await broker.close().catch(() => undefined);
    await db.destroy().catch(() => undefined);
    throw error;
  }

  // Mỗi tick duyệt từng tenant; lỗi của một tenant không được chặn các tenant còn lại.
  const submitDueForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of registry.all()) {
      if (signal.aborted) return;
      try {
        const report = await submitDue.execute(tenant, undefined, {
          shouldContinue: () => !signal.aborted,
        });
        if (Object.values(report).some((count) => count > 0)) {
          log.info({ tenantId: tenant.value, ...report }, 'worker submitted due topups');
        }
      } catch (error) {
        log.error({ err: error, tenantId: tenant.value }, 'submitting due topups failed');
      }
    }
  };
  const relayOutboxForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of registry.all()) {
      if (signal.aborted) return;
      try {
        const report = await relay.execute(tenant, config.orders.outboxBatch, {
          shouldContinue: () => !signal.aborted,
        });
        if (Object.values(report).some((count) => count > 0)) {
          log.info({ tenantId: tenant.value, ...report }, 'worker relayed outbox events');
        }
      } catch (error) {
        log.error({ err: error, tenantId: tenant.value }, 'relaying the outbox failed');
      }
    }
  };
  const worker = new Worker({
    intervalMs: config.workerIntervalMs,
    tasks: [submitDueForAllTenants, relayOutboxForAllTenants],
    onError: (error) => log.error({ err: error }, 'worker task failed'),
  });
  worker.start();

  return {
    app,
    stop: once(() =>
      runAll([
        () => broker.stopConsuming(),
        () => worker.stop(),
        () => app.close(),
        () => submitter.drain(),
        () => broker.close(),
        () => db.destroy(),
      ]),
    ),
  };
}
```

- [ ] **Step 6: Chạy test, lint, typecheck và toàn bộ integration**

```bash
corepack pnpm exec vitest run services/wallet
corepack pnpm test:integration order-payment service tests/e2e
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test:integration
```
Expected: PASS. Ghi chú để tránh đoán: (a) ca "survives a consumer that dies…" mất ~10–20 s vì `closeConnections` đợi management API liệt kê kết nối (~5 s) rồi consumer phải kết nối lại; nếu kết quả đến **hai** lần, đó là lỗi thật (inbox không chặn) — điều tra, không nới test; (b) nếu ca "does not lose the result when nobody is bound…" đỏ vì kết quả đến quá sớm, kiểm tra `OrdersSimulator.connect(..., { bindResults: false })` thật sự không khai báo queue; (c) `main.ts` không đổi (vẫn gọi `startService(config)`), nhưng cần thêm biến `RABBITMQ_*` khi chạy tay.

- [ ] **Step 7: Commit**

```bash
git add -A services/wallet tests pnpm-lock.yaml
git commit -m "feat(wallet): wire order payment (consumer, outbox relay, config) with RabbitMQ end-to-end tests"
```

---

### Task 10: Pact phía wallet (consumer của orders, provider cho orders)

**Files:**
- Modify: `services/wallet/package.json` (qua pnpm), `.gitignore`, `package.json` (gốc, thêm script `test:contract`)
- Create: `services/wallet/src/contract/wallet-consumer.pact.test.ts`, `services/wallet/src/contract/wallet-provider.pact.integration.test.ts`, `services/wallet/pact-fixtures/orders-wallet.json`

**Interfaces:**
- Consumes: `createOrderReadyHandler` (Task 8), `PayOrder` (Task 6), `createHarness`, `fundWallet`, `silentLogger` (Task 5), `validateEvent` (Task 1); `MessageConsumerPact`, `MessageProviderPact`, `MatchersV3`, `asynchronousBodyHandler`, `MessageProviderOptions` từ `@pact-foundation/pact@17.1.4`.
- Produces:
  - Test consumer (unit, không DB): wallet (consumer) đọc `OrderReadyForPaymentV1` từ orders (provider) bằng **chính handler production**, ghi pact vào `<gốc repo>/pacts/wallet-orders.json` (thư mục git-ignore; Jenkins publish). Pact spec mặc định (3.0.0, khớp PactNet 5 của ecommerce).
  - Test provider (integration, có DB): wallet (provider) verify pact của orders (consumer) với hai message `an OrderPaidV1 event` và `an OrderPaymentFailedV1 event`, mỗi message được dựng bằng cách chạy `PayOrder` thật rồi đọc payload từ outbox (cũng phải qua `validateEvent`). Nguồn pact: nếu có biến `PACT_BROKER_BASE_URL` thì lấy từ broker (`consumerVersionSelectors: [{ mainBranch: true }]`; `PACT_BROKER_USERNAME`/`PACT_BROKER_PASSWORD` nếu có; `PACT_PUBLISH_VERIFICATION=true` để publish kết quả với `PACT_PROVIDER_VERSION`, `PACT_PROVIDER_BRANCH`); nếu không thì dùng `services/wallet/pact-fixtures/orders-wallet.json` (pact mẫu do billing viết tay đúng như ecommerce sẽ sinh, cho đến khi ecommerce publish pact thật).
  - Script gốc `test:contract`: chạy riêng test provider (dùng cho Jenkins).

- [ ] **Step 1: Phụ thuộc và cấu hình**

```bash
corepack pnpm --filter @billing/wallet-service add -D @pact-foundation/pact@17.1.4
```
Thêm dòng `/pacts/` vào `.gitignore` (pact do test sinh ra không được commit). Thêm vào `scripts` của `package.json` gốc, dưới `"test:integration"`:
```json
    "test:contract": "vitest run --config vitest.integration.config.ts services/wallet/src/contract",
```

- [ ] **Step 2: Viết test thất bại**

`services/wallet/pact-fixtures/orders-wallet.json`:
```json
{
  "consumer": { "name": "orders" },
  "provider": { "name": "wallet" },
  "messages": [
    {
      "description": "an OrderPaidV1 event",
      "contents": {
        "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02",
        "occurredAtUtc": "2026-10-10T10:00:01Z",
        "tenantId": "acme",
        "correlationId": "corr-1",
        "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11",
        "walletTransactionId": "tx_1",
        "amount": 150000,
        "currency": "VND",
        "paidAtUtc": "2026-10-10T10:00:01Z"
      },
      "matchingRules": {
        "body": {
          "$.eventId": { "matchers": [{ "match": "type" }] },
          "$.occurredAtUtc": { "matchers": [{ "match": "type" }] },
          "$.tenantId": { "matchers": [{ "match": "type" }] },
          "$.correlationId": { "matchers": [{ "match": "type" }] },
          "$.orderId": { "matchers": [{ "match": "type" }] },
          "$.walletTransactionId": { "matchers": [{ "match": "type" }] },
          "$.amount": { "matchers": [{ "match": "integer" }] },
          "$.currency": { "matchers": [{ "match": "regex", "regex": "^(VND|USD)$" }] },
          "$.paidAtUtc": { "matchers": [{ "match": "type" }] }
        }
      }
    },
    {
      "description": "an OrderPaymentFailedV1 event",
      "contents": {
        "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c03",
        "occurredAtUtc": "2026-10-10T10:00:01Z",
        "tenantId": "acme",
        "correlationId": "corr-2",
        "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c12",
        "reason": "INSUFFICIENT_FUNDS"
      },
      "matchingRules": {
        "body": {
          "$.eventId": { "matchers": [{ "match": "type" }] },
          "$.occurredAtUtc": { "matchers": [{ "match": "type" }] },
          "$.tenantId": { "matchers": [{ "match": "type" }] },
          "$.correlationId": { "matchers": [{ "match": "type" }] },
          "$.orderId": { "matchers": [{ "match": "type" }] },
          "$.reason": {
            "matchers": [
              { "match": "regex", "regex": "^(INSUFFICIENT_FUNDS|WALLET_NOT_FOUND|CURRENCY_MISMATCH|CONFLICT)$" }
            ]
          }
        }
      }
    }
  ],
  "metadata": { "pactSpecification": { "version": "3.0.0" } }
}
```

`services/wallet/src/contract/wallet-consumer.pact.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MatchersV3, MessageConsumerPact, asynchronousBodyHandler } from '@pact-foundation/pact';
import { describe, expect, it } from 'vitest';
import { MissingTenantError, UnknownTenantError } from '../application/errors.js';
import type { PayOrderInput } from '../application/pay-order.js';
import { TenantId } from '../domain/tenant-id.js';
import { createOrderReadyHandler } from '../interface/messaging/order-ready.handler.js';
import { silentLogger } from '../test-support.js';

const { like, uuid, integer, regex, datetime } = MatchersV3;
const pactDir = fileURLToPath(new URL('../../../../pacts', import.meta.url));
const acme = TenantId.parse('acme');

describe('wallet as a consumer of the orders service', () => {
  it('reads OrderReadyForPaymentV1 with the production handler and records the contract', async () => {
    const calls: PayOrderInput[] = [];
    const handler = createOrderReadyHandler({
      registry: {
        resolve: (raw) => {
          if (raw === undefined || raw.trim() === '') throw new MissingTenantError('tenant is required');
          if (raw !== 'acme') throw new UnknownTenantError('unknown tenant');
          return acme;
        },
        all: () => [acme],
      },
      payOrder: {
        execute: async (input) => {
          calls.push(input);
          return { kind: 'PAID', walletTransactionId: 'tx_1' };
        },
      },
      log: silentLogger,
    });

    const pact = new MessageConsumerPact({ consumer: 'wallet', provider: 'orders', dir: pactDir, logLevel: 'warn' });
    await pact
      .given('an order is complete and ready to be paid')
      .expectsToReceive('an OrderReadyForPaymentV1 event')
      .withContent({
        eventId: uuid('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02'),
        occurredAtUtc: datetime("yyyy-MM-dd'T'HH:mm:ss'Z'", '2026-10-10T10:00:00Z'),
        tenantId: like('acme'),
        correlationId: like('corr-1'),
        orderId: uuid('0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11'),
        customerId: like('cust-1'),
        amount: integer(150000),
        currency: regex(/^(VND|USD)$/, 'VND'),
      })
      .withMetadata({ contentType: 'application/json' })
      .verify(
        asynchronousBodyHandler(async (body) => {
          const result = await handler({
            body: Buffer.from(JSON.stringify(body)),
            messageId: undefined,
            type: 'OrderReadyForPaymentV1',
            redelivered: false,
            retryCount: 0,
            headers: {},
          });
          expect(result).toEqual({ action: 'ack' });
        }),
      );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tenant: acme, customerId: 'cust-1', amount: 150000, currency: 'VND' });
  });

  it('wrote a pact file that names wallet as the consumer and orders as the provider', () => {
    const file = JSON.parse(readFileSync(path.join(pactDir, 'wallet-orders.json'), 'utf8')) as {
      consumer: { name: string };
      provider: { name: string };
    };
    expect(file.consumer.name).toBe('wallet');
    expect(file.provider.name).toBe('orders');
    expect(JSON.stringify(file)).toContain('an OrderReadyForPaymentV1 event');
  });
});
```

`services/wallet/src/contract/wallet-provider.pact.integration.test.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateEvent } from '@billing/contracts';
import { MessageProviderPact, type MessageProviderOptions } from '@pact-foundation/pact';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayOrder } from '../application/pay-order.js';
import { createHarness, fundWallet, silentLogger, type Harness } from '../test-support.js';

const fixturePath = fileURLToPath(new URL('../../pact-fixtures/orders-wallet.json', import.meta.url));

let h: Harness;
let pay: PayOrder;

beforeAll(async () => {
  h = await createHarness();
  pay = new PayOrder({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });
});
afterAll(async () => {
  await h.close();
});

/** Chạy PayOrder thật rồi lấy payload mà relay sẽ publish: đúng thứ ecommerce sẽ nhận. */
async function producedBy(customer: string, fund: number, amount: number): Promise<unknown> {
  await fundWallet(h, { customer, amount: fund });
  const orderId = randomUUID();
  await pay.execute({
    tenant: h.acme,
    eventId: randomUUID(),
    correlationId: 'corr-pact',
    orderId,
    customerId: customer,
    amount,
    currency: 'VND',
  });
  const row = await h.db
    .withSchema('t_acme')
    .selectFrom('outbox')
    .select('payload')
    .where('payload', 'like', `%${orderId}%`)
    .executeTakeFirstOrThrow();
  return JSON.parse(row.payload) as unknown;
}

function pactSource(): Partial<MessageProviderOptions> {
  const url = process.env.PACT_BROKER_BASE_URL?.trim();
  if (!url) return { pactUrls: [fixturePath] };
  const username = process.env.PACT_BROKER_USERNAME;
  const password = process.env.PACT_BROKER_PASSWORD;
  return {
    pactBrokerUrl: url,
    ...(username && password ? { pactBrokerUsername: username, pactBrokerPassword: password } : {}),
    consumerVersionSelectors: [{ mainBranch: true }],
    publishVerificationResult: process.env.PACT_PUBLISH_VERIFICATION === 'true',
    providerVersion: process.env.PACT_PROVIDER_VERSION ?? 'local',
    providerVersionBranch: process.env.PACT_PROVIDER_BRANCH ?? 'local',
  };
}

describe('wallet as a provider for the orders service', () => {
  it('produces the OrderPaid and OrderPaymentFailed events the orders contract expects', async () => {
    const verifier = new MessageProviderPact({
      provider: 'wallet',
      logLevel: 'warn',
      messageProviders: {
        'an OrderPaidV1 event': async () => {
          const body = await producedBy('pact-paid', 200000, 150000);
          expect(validateEvent('OrderPaidV1', body).ok).toBe(true);
          return body;
        },
        'an OrderPaymentFailedV1 event': async () => {
          const body = await producedBy('pact-broke', 1000, 150000);
          expect(validateEvent('OrderPaymentFailedV1', body).ok).toBe(true);
          return body;
        },
      },
      ...pactSource(),
    });
    await verifier.verify();
  }, 120_000);

  it('keeps the checked-in sample pact itself valid against the published schemas', () => {
    const pact = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      messages: Array<{ description: string; contents: unknown }>;
    };
    const byDescription = new Map(pact.messages.map((m) => [m.description, m.contents]));
    expect(validateEvent('OrderPaidV1', byDescription.get('an OrderPaidV1 event')).ok).toBe(true);
    expect(validateEvent('OrderPaymentFailedV1', byDescription.get('an OrderPaymentFailedV1 event')).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet/src/contract/wallet-consumer.pact.test.ts` rồi `corepack pnpm test:contract`
Expected: FAIL trước khi có dependency/handler; sau Step 1 (đã cài) và vì mọi phần phụ thuộc đã có từ Task 1–9, ca consumer có thể đã xanh ngay — điều đó chấp nhận được vì đây là test tích hợp hợp đồng chứ không phải code mới; ghi vào báo cáo kết quả RED/GREEN thực tế. Để có RED thật: chạy test provider **trước khi** tạo `pact-fixtures/orders-wallet.json` (lỗi không đọc được file pact), rồi tạo file.

- [ ] **Step 4: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run services/wallet/src/contract/wallet-consumer.pact.test.ts
corepack pnpm test:contract
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
ls pacts && git status --short pacts
```
Expected: PASS; `pacts/wallet-orders.json` tồn tại nhưng **không** nằm trong `git status` (đã ignore). Nếu TypeScript phàn nàn kiểu trả về của `messageProviders` (message provider phải trả `Message`), bọc giá trị trả về bằng `as never` ở đúng hai chỗ và ghi vào báo cáo; nếu `pactSource()` không khớp `MessageProviderOptions` thì đổi kiểu trả về sang `Record<string, unknown>` và truyền bằng spread như hiện tại.

- [ ] **Step 5: Commit**

```bash
git add -A services/wallet package.json .gitignore pnpm-lock.yaml
git commit -m "test(wallet): Pact consumer (orders) and provider (OrderPaid/OrderPaymentFailed) with sample fixture"
```

---

### Task 11: Pact Broker (compose overlay), Jenkins và tài liệu vận hành

**Files:**
- Create: `deploy/compose.pact-broker.yml`, `docs/integration/pact-broker.vi.md`
- Modify: `deploy/.env.example`, `Jenkinsfile`

**Interfaces:**
- Consumes: script `test:contract` và thư mục `pacts/` (Task 10).
- Produces:
  - `deploy/compose.pact-broker.yml`: dịch vụ `pact-db` (`postgres:16-alpine`, volume, healthcheck) và `pact-broker` (`pactfoundation/pact-broker`, đợi DB khỏe, cổng `${PACT_BROKER_PORT:-9292}`, basic auth, `PACT_BROKER_ALLOW_PUBLIC_READ=false`). Biến bắt buộc (không có mặc định): `PACT_BROKER_DB_PASSWORD` (chỉ dùng ký tự an toàn cho URL), `PACT_BROKER_USERNAME`, `PACT_BROKER_PASSWORD`.
  - `Jenkinsfile`: stage `Contract tests (Pact)` chỉ chạy khi tham số `PACT_BROKER_BASE_URL` khác rỗng: publish pact của wallet (consumer) → verify provider wallet và publish kết quả → `can-i-deploy` (mặc định chỉ cảnh báo: `unstable`; `PACT_ENFORCE_CAN_I_DEPLOY=true` thì làm hỏng build). Bí mật lấy từ credential Jenkins (`PACT_BROKER_CREDENTIALS_ID`, loại username/password) và truyền cho container bằng **tên biến môi trường**, không đưa giá trị lên dòng lệnh.
  - Tài liệu `docs/integration/pact-broker.vi.md`: chạy broker cục bộ, publish, verify, `can-i-deploy`, cấu hình Jenkins, giới hạn hiện tại.

- [ ] **Step 1: Viết cấu hình**

`deploy/compose.pact-broker.yml`:
```yaml
# Pact Broker dùng chung cho billing và ecommerce (hợp đồng hai chiều). Chạy cục bộ hoặc trên máy dùng chung:
#   cp deploy/.env.example deploy/.env   # điền PACT_BROKER_*
#   docker compose -f deploy/compose.pact-broker.yml --env-file deploy/.env up -d
# Manifest K8s cho môi trường thật thuộc hạ tầng chung (Bước 6), không nằm trong file này.
name: pact-broker

services:
  pact-db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: pact
      POSTGRES_PASSWORD: ${PACT_BROKER_DB_PASSWORD:?set in deploy/.env}
      POSTGRES_DB: pact
    volumes:
      - pact-db-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U pact -d pact']
      interval: 5s
      timeout: 5s
      retries: 20

  pact-broker:
    # Ghim phiên bản cụ thể khi triển khai thật; `latest` chỉ để thử cục bộ.
    image: pactfoundation/pact-broker:latest
    restart: unless-stopped
    depends_on:
      pact-db:
        condition: service_healthy
    ports:
      - '${PACT_BROKER_PORT:-9292}:9292'
    environment:
      PACT_BROKER_DATABASE_ADAPTER: postgres
      # Mật khẩu nằm trong URL nên chỉ dùng ký tự an toàn cho URL (chữ, số, `-`, `_`).
      PACT_BROKER_DATABASE_URL: postgres://pact:${PACT_BROKER_DB_PASSWORD}@pact-db/pact
      PACT_BROKER_BASIC_AUTH_USERNAME: ${PACT_BROKER_USERNAME:?set in deploy/.env}
      PACT_BROKER_BASIC_AUTH_PASSWORD: ${PACT_BROKER_PASSWORD:?set in deploy/.env}
      PACT_BROKER_ALLOW_PUBLIC_READ: 'false'

volumes:
  pact-db-data:
```

Thêm vào cuối `deploy/.env.example`:
```
# Pact Broker (deploy/compose.pact-broker.yml). Mật khẩu DB chỉ gồm chữ, số, `-`, `_` vì nằm trong URL
PACT_BROKER_PORT=9292
PACT_BROKER_DB_PASSWORD=
PACT_BROKER_USERNAME=
PACT_BROKER_PASSWORD=
```

`Jenkinsfile`: thêm hai tham số vào khối `parameters` (cạnh `SONARQUBE_SERVER`):
```groovy
        string(name: 'PACT_BROKER_BASE_URL', defaultValue: '',
               description: 'Địa chỉ Pact Broker dùng chung; để trống thì bỏ qua các bước publish/verify/can-i-deploy')
        string(name: 'PACT_BROKER_CREDENTIALS_ID', defaultValue: 'pact-broker',
               description: 'Credential Jenkins (username/password) của Pact Broker')
        booleanParam(name: 'PACT_ENFORCE_CAN_I_DEPLOY', defaultValue: false,
                     description: 'Bật khi ecommerce đã verify pact: can-i-deploy "no" sẽ làm hỏng build thay vì chỉ cảnh báo')
```
và thêm stage sau `Integration tests`, trước `SonarQube`:
```groovy
        stage('Contract tests (Pact)') {
            when { expression { params.PACT_BROKER_BASE_URL?.trim() } }
            steps {
                withCredentials([usernamePassword(credentialsId: params.PACT_BROKER_CREDENTIALS_ID,
                                                  usernameVariable: 'PACT_BROKER_USERNAME',
                                                  passwordVariable: 'PACT_BROKER_PASSWORD')]) {
                    withEnv(["PACT_BROKER_BASE_URL=${params.PACT_BROKER_BASE_URL}",
                             "PACT_PROVIDER_VERSION=${env.GIT_COMMIT}",
                             "PACT_PROVIDER_BRANCH=${env.BRANCH_NAME ?: 'main'}"]) {
                        // pact do test đơn vị của wallet (consumer) sinh ra ở stage Test, nằm trong ./pacts
                        sh '''
                            set -eu
                            docker run --rm -v "$WORKSPACE/pacts:/pacts" \
                              -e PACT_BROKER_BASE_URL -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
                              pactfoundation/pact-cli:latest pact-broker publish /pacts \
                              --consumer-app-version "$PACT_PROVIDER_VERSION" --branch "$PACT_PROVIDER_BRANCH"
                            PACT_PUBLISH_VERIFICATION=true corepack pnpm test:contract
                        '''
                        script {
                            def status = sh(returnStatus: true, script: '''
                                docker run --rm \
                                  -e PACT_BROKER_BASE_URL -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
                                  pactfoundation/pact-cli:latest pact-broker can-i-deploy \
                                  --pacticipant wallet --version "$PACT_PROVIDER_VERSION"
                            ''')
                            if (status != 0) {
                                if (params.PACT_ENFORCE_CAN_I_DEPLOY) {
                                    error('can-i-deploy: không an toàn để triển khai wallet')
                                } else {
                                    unstable('can-i-deploy: "no" (chỉ cảnh báo cho đến khi ecommerce verify pact)')
                                }
                            }
                        }
                    }
                }
            }
        }
```
(Giả định agent Jenkins chạy trực tiếp trên host có Docker, không phải container lồng nhau; nếu khác thì đường dẫn `-v "$WORKSPACE/pacts"` phải đổi theo cách agent chia sẻ volume — ghi vào tài liệu.)

`docs/integration/pact-broker.vi.md`:
````markdown
# Pact Broker cho hợp đồng wallet ↔ orders

Hai chiều hợp đồng giữa billing và ecommerce được kiểm bằng Pact (message pact):

| Event | Consumer | Provider |
|---|---|---|
| `OrderReadyForPaymentV1` | `wallet` | `orders` |
| `OrderPaidV1`, `OrderPaymentFailedV1` | `orders` | `wallet` |

Broker là nơi hai repo gặp nhau: mỗi bên publish pact và kết quả verify của mình, `can-i-deploy` cho biết một phiên bản
có an toàn để triển khai không. JSON Schema trong `packages/contracts` vẫn là chốt chặn thứ hai ở mỗi bên.

## Chạy broker cục bộ

```bash
cp deploy/.env.example deploy/.env      # điền PACT_BROKER_DB_PASSWORD, PACT_BROKER_USERNAME, PACT_BROKER_PASSWORD
docker compose -f deploy/compose.pact-broker.yml --env-file deploy/.env up -d
curl -u "$PACT_BROKER_USERNAME:$PACT_BROKER_PASSWORD" http://localhost:9292/diagnostic/status/heartbeat
```

`PACT_BROKER_DB_PASSWORD` chỉ gồm chữ, số, `-`, `_` vì nằm trong URL kết nối Postgres.

## Publish pact của wallet (consumer)

`corepack pnpm test` sinh `pacts/wallet-orders.json` (thư mục `pacts/` không được commit). Rồi:

```bash
docker run --rm --network pact-broker_default -v "$PWD/pacts:/pacts" \
  -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker publish /pacts \
  --consumer-app-version "$(git rev-parse --short HEAD)" --branch "$(git branch --show-current)"
```

Git Bash trên Windows: đặt `MSYS_NO_PATHCONV=1` và dùng `$(pwd -W)/pacts` cho phần trước dấu `:`.

## Verify wallet (provider) và publish kết quả

```bash
PACT_BROKER_BASE_URL=http://localhost:9292 PACT_BROKER_USERNAME=... PACT_BROKER_PASSWORD=... \
PACT_PUBLISH_VERIFICATION=true PACT_PROVIDER_VERSION="$(git rev-parse --short HEAD)" \
PACT_PROVIDER_BRANCH="$(git branch --show-current)" corepack pnpm test:contract
```

Không đặt `PACT_BROKER_BASE_URL` thì test verify pact mẫu `services/wallet/pact-fixtures/orders-wallet.json`.

## `can-i-deploy`

```bash
docker run --rm --network pact-broker_default \
  -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker can-i-deploy --pacticipant wallet --version "$(git rev-parse --short HEAD)"
```

"no" nghĩa là còn pact chưa được verify hoặc verify thất bại; "yes" khi mọi hợp đồng của phiên bản đó đã được verify.

## Jenkins

Stage `Contract tests (Pact)` chỉ chạy khi tham số `PACT_BROKER_BASE_URL` khác rỗng. Credential kiểu username/password
(`PACT_BROKER_CREDENTIALS_ID`, mặc định `pact-broker`) được truyền cho container bằng tên biến môi trường. `can-i-deploy` "no"
chỉ làm build `UNSTABLE` cho đến khi bật `PACT_ENFORCE_CAN_I_DEPLOY`. Giả định agent có Docker trực tiếp trên host
(đường dẫn `-v "$WORKSPACE/pacts"` phải đổi nếu agent là container lồng nhau).

## Giới hạn hiện tại

- Ecommerce chưa nối CI vào broker: pact `orders → wallet` lấy từ pact mẫu khi chạy cục bộ và từ broker khi ecommerce đã publish.
- Manifest K8s và Vault cho broker thuộc hạ tầng chung (Bước 6).
- Ghim phiên bản image `pactfoundation/pact-broker` khi triển khai thật.
````

- [ ] **Step 2: Kiểm chứng bằng broker thật (không có Docker thì ghi rõ là chưa thử)**

Chạy đúng chuỗi sau (cổng `19292` để không đụng cổng đang dùng); ghi lại **kết quả thật** vào báo cáo:
```bash
export PACT_BROKER_PORT=19292 PACT_BROKER_DB_PASSWORD=pactdb_test_pw PACT_BROKER_USERNAME=u PACT_BROKER_PASSWORD=p
docker compose -f deploy/compose.pact-broker.yml config > /dev/null && echo "compose ok"
docker compose -f deploy/compose.pact-broker.yml up -d
for i in $(seq 1 30); do [ "$(curl -s -o /dev/null -w '%{http_code}' -u u:p http://localhost:19292/diagnostic/status/heartbeat)" = 200 ] && break; sleep 2; done
corepack pnpm test                                   # sinh pacts/wallet-orders.json
export MSYS_NO_PATHCONV=1
docker run --rm --network pact-broker_default -v "$(pwd -W)/pacts:/pacts" \
  -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker publish /pacts --consumer-app-version local1 --branch main
# pact của orders (mẫu) lên broker để provider wallet có gì để verify
docker run --rm --network pact-broker_default -v "$(pwd -W)/services/wallet/pact-fixtures:/pacts" \
  -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker publish /pacts/orders-wallet.json --consumer-app-version orders1 --branch main
docker run --rm --network pact-broker_default -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker can-i-deploy --pacticipant wallet --version wallet1 || echo "expected: no (not verified yet)"
PACT_BROKER_BASE_URL=http://localhost:19292 PACT_PUBLISH_VERIFICATION=true PACT_PROVIDER_VERSION=wallet1 PACT_PROVIDER_BRANCH=main corepack pnpm test:contract
docker run --rm --network pact-broker_default -e PACT_BROKER_BASE_URL=http://pact-broker:9292 -e PACT_BROKER_USERNAME -e PACT_BROKER_PASSWORD \
  pactfoundation/pact-cli:latest pact-broker can-i-deploy --pacticipant wallet --version wallet1
docker compose -f deploy/compose.pact-broker.yml down -v
```
Expected: `compose ok`; heartbeat 200; publish thành công cả hai; `can-i-deploy` lần đầu "no" (còn pact `wallet → orders` chưa được orders verify nên có thể vẫn "no" ở lần hai — khi đó chỉ chú ý rằng pact `orders → wallet` đã `true`: ghi đúng bảng kết quả vào báo cáo; đây là lý do Jenkins đặt `can-i-deploy` ở chế độ cảnh báo mặc định). Nếu CLI không nhận biến môi trường `PACT_BROKER_*` thay cho `--broker-*`, ghi lại và dùng tùy chọn dòng lệnh trong Jenkinsfile chỉ với `--broker-token` hoặc bọc qua `docker run --env-file`.
Đảm bảo `docker compose … down -v` luôn được chạy kể cả khi bước giữa lỗi.

- [ ] **Step 3: Kiểm tra tĩnh và commit**

```bash
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
git add -A deploy docs Jenkinsfile
git commit -m "feat(ci): Pact Broker compose overlay, conditional Pact stage in Jenkins, runbook"
```
(Jenkinsfile không chạy được cục bộ: ghi rõ trong báo cáo rằng chỉ đã soát cú pháp bằng mắt.)

---

### Task 12: Script init RabbitMQ (user ecommerce, exchange, quyền hẹp), ADR-0009, README

**Files:**
- Modify: `deploy/scripts/init-rabbitmq.sh` (viết lại), `deploy/compose.billing.yml`, `deploy/.env.example`, `README.md`, `docs/architecture/README.md`
- Create: `tools/rabbitmq-init.test.ts`, `docs/adr/0009-order-payment-outbox-and-topology.vi.md`

**Interfaces:**
- Consumes: `BILLING_VHOST_PERMISSIONS`, `BILLING_EXCHANGES` từ `@billing/testing` (Task 2).
- Produces: script `init-rabbitmq.sh` idempotent tạo vhost `billing`, user `billing_wallet`, `ecommerce_orders` (mới), `billing_payment` (không quyền), cấp cho tài khoản quản trị quyền trong vhost, và khai báo hai exchange `orders.events`, `billing.events` (topic, bền); biến môi trường mới `ECOMMERCE_MQ_PASSWORD` (compose: `BILLING_ECOMMERCE_MQ_PASSWORD`). Test tĩnh đảm bảo script khớp nguyên văn `BILLING_VHOST_PERMISSIONS`, không nhắc `amq.default` và không cấp `.*` cho user dịch vụ.

- [ ] **Step 1: Viết test thất bại**

`tools/rabbitmq-init.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BILLING_EXCHANGES, BILLING_VHOST_PERMISSIONS } from '@billing/testing';
import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('../deploy/scripts/init-rabbitmq.sh', import.meta.url), 'utf8');
void fileURLToPath;

/** Giá trị như nó xuất hiện trong dấu nháy đơn của shell: regex `\.` được JSON thoát thành `\\.`. */
const shellValue = (value: string): string => `'${JSON.stringify(value).slice(1, -1)}'`;

describe('deploy/scripts/init-rabbitmq.sh', () => {
  it.each(Object.entries(BILLING_VHOST_PERMISSIONS))(
    'grants %s exactly the permissions the spec and the test helper use',
    (user, permission) => {
      const expected = `permit ${user} ${shellValue(permission.configure)} ${shellValue(permission.write)} ${shellValue(permission.read)}`;
      expect(script.split('\n').map((line) => line.trim())).toContain(expected);
    },
  );

  it('declares both integration exchanges as durable topic exchanges', () => {
    for (const name of BILLING_EXCHANGES) {
      expect(script).toContain(`put "exchanges/billing/${name}" '{"type":"topic","durable":true}'`);
    }
  });

  it('never involves the default exchange and never gives a service user a wildcard', () => {
    expect(script).not.toContain('amq.default');
    const serviceGrants = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^permit (billing_|ecommerce_)/.test(line));
    expect(serviceGrants).toHaveLength(3);
    for (const line of serviceGrants) expect(line).not.toContain("'.*'");
  });

  it('keeps billing_payment without any permission until it needs the broker', () => {
    expect(script).toContain("permit billing_payment '' '' ''");
  });

  it('gives the admin account access to the vhost before declaring exchanges', () => {
    const adminGrant = script.indexOf('permit "$RABBITMQ_ADMIN_USER"');
    const firstExchange = script.indexOf('put "exchanges/billing/');
    expect(adminGrant).toBeGreaterThan(-1);
    expect(adminGrant).toBeLessThan(firstExchange);
  });

  it('reads every password from the environment and embeds none', () => {
    for (const variable of ['WALLET_MQ_PASSWORD', 'PAYMENT_MQ_PASSWORD', 'ECOMMERCE_MQ_PASSWORD']) {
      expect(script).toContain(`"$${variable}"`);
    }
  });
});
```
(Xóa dòng `void fileURLToPath;` và import `fileURLToPath` nếu lint báo thừa; test chỉ cần `new URL(…, import.meta.url)`.)

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run tools/rabbitmq-init.test.ts`
Expected: FAIL (script chưa có `permit`, chưa có exchange).

- [ ] **Step 3: Cài đặt**

Thay toàn bộ `deploy/scripts/init-rabbitmq.sh`:
```sh
#!/bin/sh
# Tạo vhost "billing", các user riêng và hai exchange tích hợp qua management API. Idempotent (PUT).
# Quyền lấy nguyên văn từ spec Bước 4 mục 3; tools/rabbitmq-init.test.ts chống lệch với @billing/testing.
set -eu

base="http://${RABBITMQ_HOST}:${RABBITMQ_MGMT_PORT}/api"
auth="${RABBITMQ_ADMIN_USER}:${RABBITMQ_ADMIN_PASSWORD}"

put() { curl -fsS -u "$auth" -H 'content-type: application/json' -X PUT "$base/$1" -d "$2"; }
user() { put "users/$1" "{\"password\":\"$2\",\"tags\":\"\"}"; }
permit() { put "permissions/billing/$1" "{\"configure\":\"$2\",\"write\":\"$3\",\"read\":\"$4\"}"; }

put "vhosts/billing" '{}'
# Tài khoản quản trị cần quyền trong vhost thì mới khai báo được exchange.
permit "$RABBITMQ_ADMIN_USER" '.*' '.*' '.*'

user billing_wallet "$WALLET_MQ_PASSWORD"
permit billing_wallet '^wallet\\..*' '^(billing\\.events|wallet\\..*)$' '^(orders\\.events|wallet\\..*)$'

user ecommerce_orders "$ECOMMERCE_MQ_PASSWORD"
permit ecommerce_orders '^ecommerce\\..*' '^(orders\\.events|ecommerce\\..*)$' '^(billing\\.events|ecommerce\\..*)$'

# Payment chưa dùng RabbitMQ: có tài khoản nhưng không có quyền nào.
user billing_payment "$PAYMENT_MQ_PASSWORD"
permit billing_payment '' '' ''

put "exchanges/billing/orders.events" '{"type":"topic","durable":true}'
put "exchanges/billing/billing.events" '{"type":"topic","durable":true}'

echo "rabbitmq: vhost 'billing', service users and integration exchanges ready"
```

`deploy/compose.billing.yml`, dịch vụ `billing-rabbitmq-init`: thêm vào `environment` dòng `ECOMMERCE_MQ_PASSWORD: ${BILLING_ECOMMERCE_MQ_PASSWORD:?set in deploy/.env}`. `deploy/.env.example`: thêm `BILLING_ECOMMERCE_MQ_PASSWORD=` ngay sau `BILLING_PAYMENT_MQ_PASSWORD=`.

`docs/adr/0009-order-payment-outbox-and-topology.vi.md`:
```markdown
# ADR-0009: Trả order qua RabbitMQ — outbox theo tenant, publish có `mandatory`, topology không dùng default exchange

**Trạng thái:** Chấp nhận — 2026-10-10

## Bối cảnh

Wallet phải trừ ví đúng một lần cho mỗi order dù message bị giao lại hoặc nhiều consumer chạy song song, và báo kết quả cho
ecommerce mà không bao giờ mất (kể cả khi broker hoặc ecommerce tạm thời không sẵn sàng).

## Quyết định

- `PayOrder` ghi inbox, sổ cái (`ORDER_PAYMENT`, `business_key = order:<orderId>`), `order_payments` và dòng outbox trong
  **một** transaction của schema tenant. Kết quả từ chối nghiệp vụ cũng commit (inbox + outbox) và được ack.
- Relay chiếm một dòng outbox bằng lease, publish **ngoài** transaction, rồi đánh dấu đã gửi: giao ít nhất một lần, bên
  nhận khử trùng theo `eventId`. Publish dùng confirm và cờ `mandatory`; `NO_ROUTE` là thất bại và dòng được thử lại
  (không mất kết quả khi ecommerce chưa khai báo queue).
- Consumer retry theo bậc TTL qua exchange `wallet.retry`/`wallet.work` rồi DLQ; không dùng default exchange vì quyền ghi
  `amq.default` cho phép ghi vào mọi queue của vhost. Quyền của từng user giới hạn theo tiền tố queue và theo exchange.
- Kết nối dùng `recovery` của `amqplib`; sau mỗi lần kết nối lại, channel và consumer được dựng lại.

## Phương án đã loại

- Publish trực tiếp trong use case: mất event nếu publish lỗi sau commit, hoặc mất tiền nếu commit lỗi sau publish.
- Outbox dùng chung một bảng ngoài schema tenant: phá cô lập tenant (ADR-0006) và cần quan hệ chéo schema.
- Retry bằng default exchange / `sendToQueue`: cần quyền ghi `amq.default` (đã kiểm chứng bằng thử nghiệm thật).

## Hệ quả

Chết giữa commit và ack → message giao lại và bị inbox chặn (không trừ lại, không phát lại event). Chết giữa publish và
`markSent` → event được gửi lại sau lease; ecommerce phải khử trùng theo `eventId`. Thứ tự giữa các order không được đảm bảo.
Wallet xử lý từng tenant tuần tự trong mỗi lượt worker (tối đa `OUTBOX_BATCH` dòng mỗi tenant), nên một tenant tồn đọng có
thể làm các tenant khác chậm hơn khi broker lỗi.
```

`README.md`: thêm mục sau mục Wallet (trước "### Test"):
````markdown
## Thanh toán order qua RabbitMQ

Khi ecommerce hoàn tất một order, nó publish `OrderReadyForPaymentV1` vào exchange `orders.events` (vhost `billing`);
wallet trừ ví một lần duy nhất cho mỗi `orderId` và trả `OrderPaidV1` hoặc `OrderPaymentFailedV1` qua `billing.events`.
Thiết kế: [`docs/superpowers/specs/2026-10-10-order-payment-integration-design.md`](docs/superpowers/specs/2026-10-10-order-payment-integration-design.md);
quyết định: ADR-0008, ADR-0009; bàn giao cho ecommerce: [`docs/integration/orders-handoff.vi.md`](docs/integration/orders-handoff.vi.md);
Pact Broker: [`docs/integration/pact-broker.vi.md`](docs/integration/pact-broker.vi.md).

```bash
# 1. Tạo vhost, user và exchange tích hợp trên RabbitMQ dùng chung (xem deploy/compose.billing.yml)
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-rabbitmq-init

# 2. Chạy wallet với RABBITMQ_* (xem services/wallet/.env.example)
corepack pnpm --filter @billing/wallet-service start
```
````
`docs/architecture/README.md`: thêm mục trước "## Kiểm thử":
```markdown
## Messaging (RabbitMQ)

`@billing/messaging` bọc `amqplib` 2.x. Quy tắc: publish luôn có confirm và `mandatory` (không định tuyến được là thất bại);
không bao giờ dùng default exchange (`amq.default`) làm DLX hay để publish; consumer ack chỉ sau khi transaction DB đã
commit; retry theo bậc TTL qua exchange riêng rồi DLQ; kết nối tự phục hồi và dựng lại channel/consumer trong `setup`.
Exchange tích hợp (`orders.events`, `billing.events`) do script init khai báo, service chỉ kiểm tra bằng passive check.
```

- [ ] **Step 4: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run tools
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS.

- [ ] **Step 5: Kiểm chứng script trên RabbitMQ thật (không có Docker thì ghi rõ là chưa thử)**

```bash
docker run -d --name mq-init-probe -p 25672:5672 -p 25673:15672 rabbitmq:3-management-alpine
for i in $(seq 1 40); do curl -fsS -u guest:guest http://localhost:25673/api/overview >/dev/null 2>&1 && break; sleep 2; done
export RABBITMQ_HOST=localhost RABBITMQ_MGMT_PORT=25673 RABBITMQ_ADMIN_USER=guest RABBITMQ_ADMIN_PASSWORD=guest \
  WALLET_MQ_PASSWORD=wallet-pw PAYMENT_MQ_PASSWORD=payment-pw ECOMMERCE_MQ_PASSWORD=ecom-pw
sh deploy/scripts/init-rabbitmq.sh && sh deploy/scripts/init-rabbitmq.sh     # lần hai phải chạy lại được
curl -fsS -u guest:guest http://localhost:25673/api/permissions/billing/billing_wallet; echo
curl -fsS -u guest:guest http://localhost:25673/api/permissions/billing/ecommerce_orders; echo
curl -fsS -u guest:guest http://localhost:25673/api/permissions/billing/billing_payment; echo
curl -fsS -u guest:guest http://localhost:25673/api/exchanges/billing | grep -o '"name":"[a-z]*\.events"'
```
Tạo `.superpowers/probe-init.ts` (thư mục git-ignore cục bộ; xóa sau khi chạy) để chứng minh wallet dựng được topology thật bằng tài khoản hẹp do script tạo:
```ts
import { BrokerClient } from '../packages/messaging/src/index.ts';
import { orderPaymentsTopology } from '../services/wallet/src/interface/messaging/order-payments.topology.ts';

const log = { info: () => undefined, warn: console.warn, error: console.error };
const client = await BrokerClient.connect({
  config: { host: 'localhost', port: 25672, vhost: 'billing', user: 'billing_wallet', password: 'wallet-pw' },
  log,
});
await client.consume({ topology: orderPaymentsTopology([5, 30, 120]), prefetch: 5, handler: async () => ({ action: 'ack' }) });
console.log('wallet topology declared with the restricted account');
await client.close();
```
Chạy `corepack pnpm exec tsx .superpowers/probe-init.ts`, rồi `docker rm -f mq-init-probe`.
Expected: script chạy được hai lần; ba lệnh `permissions` trả đúng chuỗi regex; có đủ hai exchange; probe in `wallet topology declared…`. Ghi kết quả thật vào báo cáo (luôn `docker rm -f` kể cả khi lỗi).

- [ ] **Step 6: Commit**

```bash
git add -A deploy docs tools README.md
git commit -m "feat(deploy): RabbitMQ init for orders integration (ecommerce user, exchanges, tight permissions), ADR-0009"
```

---

### Task 13: Tài liệu bàn giao cho team ecommerce

**Files:**
- Create: `docs/integration/orders-handoff.vi.md`, `tools/handoff-doc.test.ts`

**Interfaces:**
- Consumes: `validateEvent` (Task 1).
- Produces: tài liệu bàn giao có ví dụ JSON cho ba event; test đảm bảo mọi ví dụ trong tài liệu hợp lệ theo schema (đánh dấu bằng `<!-- example: <TênEvent> -->` ngay trước khối ```json).

- [ ] **Step 1: Viết test thất bại**

`tools/handoff-doc.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { validateEvent, type EventName } from '@billing/contracts';
import { describe, expect, it } from 'vitest';

const doc = readFileSync(new URL('../docs/integration/orders-handoff.vi.md', import.meta.url), 'utf8');
const examples = [...doc.matchAll(/<!-- example: (\w+) -->\s*```json\n([\s\S]*?)\n```/g)].map((match) => ({
  name: match[1] as EventName,
  json: JSON.parse(match[2] ?? 'null') as unknown,
}));

describe('docs/integration/orders-handoff.vi.md', () => {
  it('carries an example for each of the three events', () => {
    expect(examples.map((e) => e.name).sort()).toEqual(['OrderPaidV1', 'OrderPaymentFailedV1', 'OrderReadyForPaymentV1']);
  });

  it.each(examples)('has a $name example that satisfies the published schema', ({ name, json }) => {
    const result = validateEvent(name, json);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('names the routing keys and the vhost the handoff relies on', () => {
    for (const text of ['order-ready-for-payment.v1', 'order-paid.v1', 'order-payment-failed.v1', 'vhost `billing`', 'ecommerce_orders']) {
      expect(doc).toContain(text);
    }
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run tools/handoff-doc.test.ts`
Expected: FAIL (chưa có tài liệu).

- [ ] **Step 3: Viết tài liệu**

`docs/integration/orders-handoff.vi.md`:
````markdown
# Bàn giao cho team ecommerce: thanh toán order từ ví billing

Khi một order hoàn tất, ecommerce báo cho billing qua RabbitMQ; wallet trừ số dư ví của khách một lần duy nhất cho mỗi
`orderId` rồi báo kết quả. Sau khi nhận `OrderPaidV1`, order chuyển `Unpaid → Paid`.

```text
orders ── OrderReadyForPaymentV1 ──▶ orders.events ──▶ wallet (trừ ví, ghi sổ kép)
orders ◀── OrderPaidV1 / OrderPaymentFailedV1 ◀── billing.events ◀── wallet (qua outbox)
```

## Việc cần làm phía ecommerce

1. Thêm trạng thái `Unpaid`/`Paid` cho Order. Chỉ chuyển `Unpaid → Paid` khi nhận `OrderPaidV1`; bỏ qua nếu đã `Paid`.
2. Publish `OrderReadyForPaymentV1` qua outbox khi order hoàn tất. `amount` là **số nguyên minor unit** (VND: đồng, USD: cent)
   kèm `currency`; adapter đổi từ `total decimal` của `OrderPlacedV1`.
3. Consume `OrderPaidV1` và `OrderPaymentFailedV1` từ `billing.events`, khử trùng theo `eventId` (wallet giao ít nhất một
   lần). `OrderPaymentFailedV1` chỉ ghi lý do và giữ order ở `Unpaid`.
4. Cấu hình MassTransit gửi/nhận **JSON thuần** (không envelope MassTransit) tới vhost `billing` bằng user `ecommerce_orders`.
5. Đưa schema vào `shared/EventContracts` (có test bất biến sẵn của repo), viết và verify Pact, nối Pact Broker.

## Hợp đồng

JSON phẳng, camelCase; trường lạ phải được bỏ qua (tolerant reader). Schema JSON Schema 2020-12 nằm ở `packages/contracts`
của billing; lấy bản file bằng `corepack pnpm --filter @billing/contracts emit` (thư mục `packages/contracts/dist/schemas/`):
`OrderReadyForPayment.v1.schema.json`, `OrderPaid.v1.schema.json`, `OrderPaymentFailed.v1.schema.json`.

| Event | Phát → nhận | Routing key | Trường nghiệp vụ |
|---|---|---|---|
| `OrderReadyForPaymentV1` | orders → wallet | `order-ready-for-payment.v1` | `orderId` (UUID), `customerId`, `amount`, `currency` |
| `OrderPaidV1` | wallet → orders | `order-paid.v1` | `orderId`, `walletTransactionId`, `amount`, `currency`, `paidAtUtc` |
| `OrderPaymentFailedV1` | wallet → orders | `order-payment-failed.v1` | `orderId`, `reason` |

Trường chung bắt buộc của cả ba: `eventId` (UUID), `occurredAtUtc` (ISO 8601 UTC), `tenantId`, `correlationId`.
`reason` ∈ `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`.

Thuộc tính AMQP wallet đặt khi phát: `contentType = application/json`, `messageId = eventId`, `type =` tên event,
`deliveryMode = 2` (persistent), header `x-correlation-id`.

<!-- example: OrderReadyForPaymentV1 -->
```json
{
  "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02",
  "occurredAtUtc": "2026-10-10T10:00:00Z",
  "tenantId": "acme",
  "correlationId": "7c1d9b0e-1a5f-4d58-9f0e-3a2b1c0d9e8f",
  "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11",
  "customerId": "cust-1",
  "amount": 150000,
  "currency": "VND"
}
```

<!-- example: OrderPaidV1 -->
```json
{
  "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c03",
  "occurredAtUtc": "2026-10-10T10:00:01Z",
  "tenantId": "acme",
  "correlationId": "7c1d9b0e-1a5f-4d58-9f0e-3a2b1c0d9e8f",
  "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11",
  "walletTransactionId": "tx_5b1d0c1c8a3f4e6f9a7b2c4d6e8f0a1b",
  "amount": 150000,
  "currency": "VND",
  "paidAtUtc": "2026-10-10T10:00:01Z"
}
```

<!-- example: OrderPaymentFailedV1 -->
```json
{
  "eventId": "3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c04",
  "occurredAtUtc": "2026-10-10T10:00:01Z",
  "tenantId": "acme",
  "correlationId": "7c1d9b0e-1a5f-4d58-9f0e-3a2b1c0d9e8f",
  "orderId": "0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11",
  "reason": "INSUFFICIENT_FUNDS"
}
```

## Broker

- vhost `billing`; hai exchange topic bền `orders.events` (ecommerce ghi) và `billing.events` (wallet ghi) do script
  `deploy/scripts/init-rabbitmq.sh` khai báo.
- User `ecommerce_orders`: ghi `orders.events`; khai báo queue có tiền tố `ecommerce.` (ví dụ `ecommerce.order-results`) và
  gắn vào `billing.events` với hai key `order-paid.v1`, `order-payment-failed.v1`; đọc queue của mình.
- Wallet publish có `mandatory`: nếu **chưa có queue nào** gắn vào `billing.events` thì kết quả không bị mất, wallet giữ lại
  và thử lại (1 s, 5 s, 30 s, 120 s, rồi 600 s mỗi lần) cho đến khi ecommerce khai báo queue. Hãy khai báo queue trước khi bật luồng.

## Quy tắc nghiệp vụ cần biết

- **Idempotency theo `orderId`:** gửi lại cùng `orderId` với cùng khách, số tiền, đồng tiền thì wallet **không trừ thêm** và phát
  lại `OrderPaidV1` với đúng `walletTransactionId` cũ (`eventId` mới). Cùng `orderId` nhưng khác khách/số tiền/đồng tiền →
  `OrderPaymentFailedV1(CONFLICT)`, không trừ tiền, wallet ghi cảnh báo.
- **Thiếu tiền** → `INSUFFICIENT_FUNDS`; wallet **không ghi nhớ** lần từ chối, nên sau khi khách nạp thêm tiền ecommerce có thể
  publish lại `OrderReadyForPaymentV1` (cùng `orderId`, `eventId` mới) để thử lại.
- Message sai schema hoặc `tenantId` wallet không phục vụ sẽ vào hàng đợi chết của wallet (`wallet.order-payments.dlq`) và không
  có phản hồi; hãy bảo đảm `tenantId` khớp danh sách tenant cấu hình ở wallet (`WALLET_TENANTS`).
- Wallet không đảm bảo thứ tự giữa các order.

## Gợi ý MassTransit (cần xác nhận phía ecommerce)

Dùng serializer/deserializer JSON thuần (`UseRawJsonSerializer`/`UseRawJsonDeserializer`), tắt tự tạo topology cho các
exchange này và trỏ endpoint tới `orders.events`/`ecommerce.*` đã khai báo sẵn. MassTransit đang ghim 8.x (xem
`Directory.Packages.props`); cách cấu hình cụ thể là việc của team ecommerce.

## Pact và Pact Broker

Hai chiều: `wallet` là consumer của `OrderReadyForPaymentV1` (provider `orders`), `orders` là consumer của `OrderPaidV1` và
`OrderPaymentFailedV1` (provider `wallet`). Pact message, spec 3.0.0 (PactNet 5 đọc được). Pact mẫu phía `orders` để tham khảo:
`services/wallet/pact-fixtures/orders-wallet.json`. Cách chạy broker và publish/verify: `docs/integration/pact-broker.vi.md`.

## Câu hỏi mở

- Danh sách tenant của gateway ecommerce phải khớp `WALLET_TENANTS` của wallet.
- Instance RabbitMQ dùng chung và cách truy cập từ máy phát triển (ADR-0004).
````

- [ ] **Step 4: Chạy test, lint, typecheck**

```bash
corepack pnpm exec vitest run tools/handoff-doc.test.ts
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
```
Expected: PASS (ba ví dụ đều hợp lệ theo schema). Nếu `prettier` định dạng lại khối JSON trong markdown, chạy `corepack pnpm exec prettier --write docs/integration/orders-handoff.vi.md` rồi chạy lại test.

- [ ] **Step 5: Commit**

```bash
git add -A docs tools
git commit -m "docs: handoff for the ecommerce team (contracts, broker, rules) with schema-checked examples"
```

---

### Task 14: Kiểm chứng toàn bộ và hoàn tất nhánh

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
Expected: tất cả PASS (payment, database, messaging, wallet, `tests/e2e`). Nếu testcontainers báo lỗi Ryuk đặt `TESTCONTAINERS_RYUK_DISABLED=true`. Chạy lại **một lần** nếu có test chập chờn do thời gian, ghi rõ test nào; nếu lỗi lặp lại thì điều tra nguyên nhân, không thêm `retry`. Sau khi chạy: `docker ps -aq --filter ancestor=rabbitmq:3-management-alpine` không được còn container rác.

- [ ] **Step 3: Đối chiếu spec — mỗi yêu cầu có test**

Đối chiếu từng dòng với test đã chạy xanh ở Step 2; dòng nào thiếu test thì thêm test (không chỉnh spec cho khớp):

| Yêu cầu trong spec Bước 4 | Test chứng minh |
|---|---|
| Ba event phẳng, schema, `tolerant reader`, routing key | `packages/contracts/src/validate.test.ts`, `emit.test.ts`, `tools/handoff-doc.test.ts` |
| Quyền RabbitMQ hẹp; exchange do init tạo; không `amq.default` | `packages/testing/src/rabbitmq.integration.test.ts`, `tools/rabbitmq-init.test.ts`, `messaging/topology.*.test.ts` |
| Publisher confirm + `mandatory`, `NO_ROUTE` là thất bại | `messaging/src/publisher.integration.test.ts`, `relay-outbox.integration.test.ts`, `order-payment.integration.test.ts` (không mất kết quả khi chưa có queue) |
| Consumer retry TTL, DLQ, reject, prefetch, dừng êm | `messaging/src/consumer.integration.test.ts` |
| Kết nối tự phục hồi; giao lại message chưa ack | `messaging/src/client.integration.test.ts`, `order-payment.integration.test.ts` (consumer chết sau commit, trước ack) |
| `PayOrder` đủ nhánh; từ chối vẫn commit; không ghi nhớ lần từ chối | `application/pay-order.integration.test.ts` |
| Chống trả trùng (inbox, `orderId`, khóa ví, `CHECK` số dư) và đồng thời | `pay-order.integration.test.ts` (10 event cùng id, 10 event khác id cùng order, 6 order tranh 3 phần tiền), `order-payment.integration.test.ts` (20 message song song) |
| Replay `OrderPaidV1` cùng `walletTransactionId`; `CONFLICT` | `pay-order.integration.test.ts`, `order-payment.integration.test.ts` |
| Outbox: lease, backoff, không bỏ dòng, publish ngoài transaction | `relay-outbox.integration.test.ts`, `order-repositories.integration.test.ts` |
| Migration `003` giữ dữ liệu cũ; index relay | `orders-migration.integration.test.ts`, `provisioning.integration.test.ts` |
| Cấu hình mới; từ chối khởi động; dọn tài nguyên khi lỗi | `config.test.ts`, `env-example.test.ts`, `order-payment.integration.test.ts` (vhost sai) |
| Pact hai chiều và Pact Broker | `contract/*.pact*.test.ts`; Task 11 Step 2 (broker thật, `can-i-deploy`) |
| Payload outbox đúng schema; tenant đúng; bất biến sổ cái | `order-events.test.ts`, `pay-order.integration.test.ts` (`afterEach` kiểm bất biến) |

- [ ] **Step 4: Rà soát bí mật và dấu vết gỡ lỗi**

```bash
git grep -nE "console\.(log|debug)" -- 'services/wallet/src' 'packages/messaging' ':!*.test.ts'
git grep -nE "(password|secret|token)\s*[:=]\s*['\"][^'\"]{6,}" -- 'services/wallet/src' 'packages/messaging' 'deploy' 'Jenkinsfile' ':!*.test.ts' ':!*.example' ':!*test-support*'
git status --short
```
Expected: không có `console.*` ngoài script/probe; không có bí mật thật trong file được commit (các mật khẩu test nằm trong `packages/testing/src/rabbitmq.ts` là hằng cho container tạm); cây làm việc sạch; `pacts/` và `.superpowers/` không bị theo dõi.

- [ ] **Step 5: Review toàn nhánh và hoàn tất**

Dispatch reviewer toàn nhánh (mô hình mạnh nhất) theo `subagent-driven-development`, sửa các phát hiện theo quy trình, rồi dùng `superpowers:finishing-a-development-branch`. **Không push và không merge nếu người dùng chưa yêu cầu rõ.**

