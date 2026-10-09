# Payment Simulator (Bước 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hiện thực service `payment` theo spec `docs/superpowers/specs/2026-10-09-payment-simulator-design.md`: `POST /charges`, `GET /charges/{id}`, `GET /settlements`, webhook ký HMAC có retry, kịch bản `X-Simulate`, idempotency key, trạng thái bền vững trên SQL Server.

**Architecture:** Bốn lớp hexagonal (`domain` thuần → `application` use case + port → `infrastructure` Kysely/HTTP/worker → `interface` Fastify). `POST /charges` chỉ ghi charge `PENDING`; một worker poll DB để hoàn tất charge đến hạn và gửi webhook (lease + `UPDLOCK, READPAST`). Hai package dùng chung mới: `@billing/database` (kết nối/migration/helper SQL Server) và `@billing/testing` (testcontainers SQL Server, clock giả, receiver webhook giả). Chữ ký và schema webhook nằm trong `@billing/contracts` để wallet dùng lại.

**Tech Stack:** Node 22, TypeScript strict, Fastify 5, Kysely 0.29 (+ tedious/tarn) trên SQL Server 2022, Vitest 5, testcontainers, `node:crypto`.

## Global Constraints

Sao chép nguyên văn từ spec payment và spec nền tảng:

- `amount`: số nguyên minor unit `>= 1`; `currency`: `VND | USD`; không dùng float; mọi tiền là `Money` trong code.
- `Idempotency-Key` bắt buộc trên `POST /charges`; cùng key + cùng nội dung → trả lại đúng phản hồi `202` đã lưu; cùng key + nội dung khác → `422`.
- `X-Simulate`: `khóa=giá trị` ngăn cách bằng dấu phẩy; khóa `fail`, `delay` (1..3600), `webhook` (`drop|duplicate`), `response` (`timeout`); giá trị lạ hoặc khóa lặp trả `400`, không đoán.
- Vòng đời `PENDING → SUCCEEDED | FAILED`, hai trạng thái sau là cuối.
- Webhook: `X-Signature: t=<unix>,v1=<hex>` với `v1 = HMAC-SHA256(secret, "<t>.<body thô>")`; `2xx` là thành công; retry theo `WEBHOOK_BACKOFF` mặc định `1,5,30,120,600` giây; hết lượt thì `FAILED` và giữ lại.
- Sao kê theo `completed_at` (UTC), gồm `SUCCEEDED` và `FAILED`, sắp theo `(completed_at, id)`; `limit` mặc định 500, tối đa 1000; tổng kiểm tính trên toàn ngày.
- DB riêng `billing_payment`, truy cập bằng Kysely; user riêng; không có giá trị mặc định cho bí mật; thiếu biến bắt buộc thì từ chối khởi động.
- Bốn lớp, lint ép ranh giới: `domain` chỉ import `@billing/money`; service không import service khác.
- Mọi response có `x-correlation-id`.
- Lệnh chạy qua `corepack pnpm ...` từ gốc repo `C:\Users\ngantran\source\repos\billing-framework`; pnpm ghim `9.15.9`, TypeScript `~5.9`.

## Quyết định thực thi (đã kiểm chứng bằng thử nghiệm với SQL Server thật)

Các điểm sau không hiển nhiên và đã được thử trên container SQL Server 2022 trước khi viết plan; code trong plan phụ thuộc vào chúng:

1. **`bigint` trả về dạng chuỗi** (`'5'`). Mọi cột `bigint` phải đi qua `toSafeInteger`.
2. **`Date` làm tham số bị mất độ chính xác mili-giây** (`.001Z` thành `.000`) vì tedious gửi `DateTime`. Luôn truyền ngày bằng `dateTime(date)` = `cast('<ISO>' as datetime2(3))`; cách này giữ chính xác từng mili-giây.
3. **`READPAST` chỉ có tác dụng khi có index hỗ trợ `ORDER BY`.** Không có index, `top (1) ... order by` quét và khóa mọi hàng nên worker thứ hai nhận về rỗng. Vì vậy bắt buộc có `ix_charges_due (status, due_at, id)` và `ix_webhook_due (status, next_attempt_at, event_id)`.
4. Vi phạm khóa duy nhất có `error.number === 2627` (hoặc `2601` với unique index).
5. `Migrator` import từ `kysely/migration` (không còn export ở gốc từ Kysely 0.29).
6. Tên cột tránh từ khóa T-SQL nên khác spec đôi chỗ: `idempotency_keys.idempotency_key`, `webhook_events.event_type`, `webhook_events.send_twice`, `webhook_attempts.attempted_at`, `webhook_attempts.error_message`. Spec được cập nhật ở Task 14.
7. **Cách đếm retry:** gửi lần đầu ngay khi charge hoàn tất, sau đó retry tối đa `len(WEBHOOK_BACKOFF)` lần (mặc định 5), tức tối đa 6 lần gửi. Lần gửi thất bại thứ `n` (`n <= len(backoff)`) hẹn lại sau `backoff[n-1]` giây; thất bại thứ `len(backoff)+1` thì `FAILED`.
8. **Lease:** worker "chiếm" sự kiện bằng cách đẩy `next_attempt_at` thêm 60 giây rồi mới gửi (ngoài transaction), sau đó ghi kết quả. Nếu tiến trình chết giữa chừng, sự kiện tự đến hạn lại sau lease.
9. `WEBHOOK_TOLERANCE_SECONDS` không dùng ở phía gửi; dung sai là tham số của `verifyWebhook` (phía nhận, mặc định 300 giây). Spec được chỉnh ở Task 14.

## File Structure

```
billing-framework/
├─ vitest.config.ts                       # sửa: loại *.integration.test.ts
├─ vitest.integration.config.ts           # mới: chạy integration + globalSetup
├─ package.json                           # sửa: script test:integration, db:migrate:payment, devDeps
├─ Jenkinsfile                            # sửa: thêm stage Integration
├─ db/payment/
│  ├─ 001-init.ts                         # migration đầu tiên
│  ├─ migrations.ts                       # Record<string, Migration>
│  ├─ migrate.ts                          # script chạy migration từ env
│  └─ migrations.integration.test.ts
├─ packages/
│  ├─ database/    src/{index,config,connection,datetime,numbers,errors,migrate}.ts + *.test.ts
│  ├─ testing/     src/{index,provided-context,sql-server.global-setup,sql-server,fake-clock,webhook-receiver,wait-for}.ts + *.test.ts + database.integration.test.ts
│  └─ contracts/   src/{ajv,webhook}.ts (+ sửa validate.ts, emit.ts, index.ts) + webhook.test.ts
└─ services/payment/
   ├─ .env.example
   └─ src/
      ├─ config.ts  bootstrap.ts  main.ts  test-support.ts
      ├─ domain/{errors,scenario,charge,webhook-event}.ts + *.test.ts
      ├─ application/{ports,errors,views,create-charge,complete-due-charges,deliver-due-webhooks,get-charge,get-settlement}.ts + *.integration.test.ts
      ├─ infrastructure/{system,worker,http-webhook-sender}.ts + kysely/{schema,mappers,charge.repository,idempotency.repository,webhook.repository,unit-of-work}.ts
      └─ interface/http/{app,errors,health.route,charges.route,settlements.route}.ts + *.test.ts
```

Quy ước test: `*.test.ts` là unit (không cần Docker, chạy bằng `corepack pnpm test`); `*.integration.test.ts` cần Docker (chạy bằng `corepack pnpm test:integration`). Test không import `kysely` trực tiếp trong thư mục `application/` hay `domain/` (lint cấm); chúng dùng `test-support.ts`.

---

### Task 1: `@billing/database`

**Files:**
- Create: `packages/database/package.json`, `src/index.ts`, `src/config.ts`, `src/connection.ts`, `src/datetime.ts`, `src/numbers.ts`, `src/errors.ts`, `src/migrate.ts`
- Test: `src/numbers.test.ts`, `src/errors.test.ts`, `src/config.test.ts`

**Interfaces:**
- Produces:
  - `interface DatabaseConfig { host: string; port: number; database: string; user: string; password: string; poolMax?: number; encrypt?: boolean; trustServerCertificate?: boolean }`
  - `class ConfigError extends Error { readonly problems: string[] }`
  - `databaseConfigFromEnv(prefix: string, env: NodeJS.ProcessEnv): DatabaseConfig` — đọc `<prefix>_HOST|PORT|NAME|USER|PASSWORD`; `PORT` mặc định 1433; ném `ConfigError` liệt kê mọi vấn đề
  - `createDatabase<DB>(config: DatabaseConfig): Kysely<DB>`
  - `dateTime(value: Date): RawBuilder<Date>`
  - `toSafeInteger(value: string | number | bigint): number` — ném `RangeError` nếu không phải safe integer
  - `isUniqueViolation(error: unknown): boolean`
  - `migrate<DB>(db: Kysely<DB>, migrations: Record<string, Migration>): Promise<string[]>` — trả về tên các migration vừa áp dụng, ném lỗi nếu thất bại
  - re-export `type Migration`

- [ ] **Step 1: Tạo nhánh làm việc và package**

```bash
git switch -c feature/payment-simulator
```

`packages/database/package.json`:
```json
{
  "name": "@billing/database",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

```bash
corepack pnpm --filter @billing/database add kysely tedious tarn
```
Expected: ba dependency được thêm, `pnpm-lock.yaml` đổi.

- [ ] **Step 2: Viết test thất bại**

`packages/database/src/numbers.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { toSafeInteger } from './numbers.js';

describe('toSafeInteger', () => {
  it.each([
    ['5', 5],
    ['-12', -12],
    [7, 7],
    [5n, 5],
    ['9007199254740991', Number.MAX_SAFE_INTEGER],
  ])('converts %j to %d', (input, expected) => {
    expect(toSafeInteger(input)).toBe(expected);
  });

  it.each(['9007199254740993', 1.5, 'abc', '1e3', '', 2 ** 60, 9007199254740993n])(
    'rejects %j',
    (input) => {
      expect(() => toSafeInteger(input)).toThrow(RangeError);
    },
  );
});
```

`packages/database/src/errors.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors.js';

describe('isUniqueViolation', () => {
  it.each([2627, 2601])('recognises SQL Server error number %d', (number) => {
    expect(isUniqueViolation({ number })).toBe(true);
  });

  it.each([null, undefined, 'x', new Error('boom'), { number: 547 }, { number: '2627' }])(
    'rejects %j',
    (value) => {
      expect(isUniqueViolation(value)).toBe(false);
    },
  );
});
```

`packages/database/src/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, databaseConfigFromEnv } from './config.js';

const full = {
  PAYMENT_DB_HOST: 'db',
  PAYMENT_DB_NAME: 'billing_payment',
  PAYMENT_DB_USER: 'u',
  PAYMENT_DB_PASSWORD: 'p',
};

describe('databaseConfigFromEnv', () => {
  it('reads values and defaults the port to 1433', () => {
    expect(databaseConfigFromEnv('PAYMENT_DB', full)).toEqual({
      host: 'db',
      port: 1433,
      database: 'billing_payment',
      user: 'u',
      password: 'p',
    });
  });

  it('uses an explicit port', () => {
    expect(databaseConfigFromEnv('PAYMENT_DB', { ...full, PAYMENT_DB_PORT: '14333' }).port).toBe(
      14333,
    );
  });

  it('lists every missing variable at once', () => {
    try {
      databaseConfigFromEnv('PAYMENT_DB', {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toEqual([
        'PAYMENT_DB_HOST is required',
        'PAYMENT_DB_NAME is required',
        'PAYMENT_DB_USER is required',
        'PAYMENT_DB_PASSWORD is required',
      ]);
    }
  });

  it.each(['abc', '0', '70000', '1.5'])('rejects invalid port %s', (port) => {
    expect(() => databaseConfigFromEnv('PAYMENT_DB', { ...full, PAYMENT_DB_PORT: port })).toThrow(
      ConfigError,
    );
  });

  it('treats blank values as missing', () => {
    expect(() => databaseConfigFromEnv('PAYMENT_DB', { ...full, PAYMENT_DB_PASSWORD: '  ' })).toThrow(
      ConfigError,
    );
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/database`
Expected: FAIL (không resolve được `./numbers.js`, `./errors.js`, `./config.js`).

- [ ] **Step 4: Cài code**

`packages/database/src/numbers.ts`:
```ts
/**
 * SQL Server `bigint` được tedious trả về dạng chuỗi. Chuyển về number có kiểm tra,
 * để tiền không bao giờ bị làm tròn âm thầm.
 */
export function toSafeInteger(value: string | number | bigint): number {
  let big: bigint | undefined;
  if (typeof value === 'bigint') {
    big = value;
  } else if (typeof value === 'number') {
    big = Number.isInteger(value) ? BigInt(value) : undefined;
  } else if (/^-?\d+$/.test(value)) {
    big = BigInt(value);
  }
  if (
    big === undefined ||
    big > BigInt(Number.MAX_SAFE_INTEGER) ||
    big < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(`not a safe integer: ${String(value)}`);
  }
  return Number(big);
}
```

`packages/database/src/errors.ts`:
```ts
/** 2627: vi phạm PRIMARY KEY/UNIQUE constraint; 2601: vi phạm unique index. */
export function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { number } = error as { number?: unknown };
  return number === 2627 || number === 2601;
}
```

`packages/database/src/config.ts`:
```ts
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMax?: number;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';

  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
  }
}

export function databaseConfigFromEnv(prefix: string, env: NodeJS.ProcessEnv): DatabaseConfig {
  const problems: string[] = [];

  const required = (suffix: string): string => {
    const name = `${prefix}_${suffix}`;
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };

  const host = required('HOST');
  const database = required('NAME');
  const user = required('USER');
  const password = required('PASSWORD');

  let port = 1433;
  const rawPort = env[`${prefix}_PORT`];
  if (rawPort !== undefined && rawPort.trim() !== '') {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`${prefix}_PORT must be an integer in 1..65535`);
    } else {
      port = parsed;
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { host, port, database, user, password };
}
```

`packages/database/src/datetime.ts`:
```ts
import { sql, type RawBuilder } from 'kysely';

/**
 * tedious gửi `Date` bằng kiểu DateTime (độ chi tiết ~3,33 ms) nên làm mất mili-giây.
 * Truyền chuỗi ISO rồi cast sang datetime2(3) thì giữ chính xác từng mili-giây.
 */
export function dateTime(value: Date): RawBuilder<Date> {
  return sql<Date>`cast(${value.toISOString()} as datetime2(3))`;
}
```

`packages/database/src/connection.ts`:
```ts
import { Kysely, MssqlDialect } from 'kysely';
import * as Tarn from 'tarn';
import * as Tedious from 'tedious';
import type { DatabaseConfig } from './config.js';

export function createDatabase<DB>(config: DatabaseConfig): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new MssqlDialect({
      tarn: { ...Tarn, options: { min: 0, max: config.poolMax ?? 10 } },
      tedious: {
        ...Tedious,
        connectionFactory: () =>
          new Tedious.Connection({
            server: config.host,
            authentication: {
              type: 'default',
              options: { userName: config.user, password: config.password },
            },
            options: {
              port: config.port,
              database: config.database,
              encrypt: config.encrypt ?? false,
              trustServerCertificate: config.trustServerCertificate ?? true,
            },
          }),
      },
    }),
  });
}
```

`packages/database/src/migrate.ts`:
```ts
import type { Kysely } from 'kysely';
import { Migrator, type Migration } from 'kysely/migration';

export type { Migration };

/** Áp dụng mọi migration chưa chạy theo thứ tự tên; ném lỗi nếu có migration thất bại. */
export async function migrate<DB>(
  db: Kysely<DB>,
  migrations: Record<string, Migration>,
): Promise<string[]> {
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: { getMigrations: async () => migrations },
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
```

`packages/database/src/index.ts`:
```ts
export { ConfigError, databaseConfigFromEnv } from './config.js';
export type { DatabaseConfig } from './config.js';
export { createDatabase } from './connection.js';
export { dateTime } from './datetime.js';
export { isUniqueViolation } from './errors.js';
export { migrate } from './migrate.js';
export type { Migration } from './migrate.js';
export { toSafeInteger } from './numbers.js';
```

- [ ] **Step 5: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run packages/database && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS; không lỗi lint hay type (đặc biệt `createDatabase` biên dịch được với kiểu của tedious).

- [ ] **Step 6: Commit**

```bash
git add packages/database pnpm-lock.yaml
git commit -m "feat(database): add SQL Server connection, config, migration and safe-type helpers"
```

---

### Task 2: `@billing/testing` và hạ tầng test tích hợp

**Files:**
- Create: `packages/testing/package.json`, `src/index.ts`, `src/provided-context.ts`, `src/sql-server.global-setup.ts`, `src/sql-server.ts`, `src/fake-clock.ts`, `src/webhook-receiver.ts`, `src/wait-for.ts`, `vitest.integration.config.ts` (gốc repo)
- Modify: `vitest.config.ts`, `package.json`
- Test: `packages/testing/src/fake-clock.test.ts`, `src/webhook-receiver.test.ts`, `src/wait-for.test.ts`, `src/database.integration.test.ts` (đặt ở đây, không đặt trong `packages/database`, để tránh vòng phụ thuộc `database` ↔ `testing`)

**Interfaces:**
- Consumes: `createDatabase`, `DatabaseConfig` từ `@billing/database`.
- Produces:
  - `createTestDatabase(prefix?: string): Promise<TestDatabase>` với `interface TestDatabase { config: DatabaseConfig; drop(): Promise<void> }` — tạo database riêng (tên ngẫu nhiên) trên SQL Server của testcontainers; chỉ dùng được trong test chạy bằng config tích hợp
  - `class FakeClock { constructor(start: Date | string); now(): Date; set(date: Date | string): void; advance(ms: number): void; advanceSeconds(seconds: number): void }`
  - `class WebhookReceiver { static start(): Promise<WebhookReceiver>; readonly url: string; readonly received: ReceivedWebhook[]; respondWith(...statuses: number[]): this; setDefaultStatus(status: number): this; setDelay(ms: number): this; close(): Promise<void> }` và `interface ReceivedWebhook { headers: IncomingHttpHeaders; body: string }`
  - `waitFor(predicate: () => boolean | Promise<boolean>, options?: { timeoutMs?: number; intervalMs?: number }): Promise<void>` — ném lỗi khi hết thời gian

- [ ] **Step 1: Tạo package và cài thư viện**

`packages/testing/package.json`:
```json
{
  "name": "@billing/testing",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./sql-server.global-setup": "./src/sql-server.global-setup.ts"
  }
}
```

```bash
corepack pnpm --filter @billing/testing add @billing/database@workspace:* kysely testcontainers @testcontainers/mssqlserver
```

- [ ] **Step 2: Viết test thất bại cho các tiện ích không cần Docker**

`packages/testing/src/fake-clock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock.js';

describe('FakeClock', () => {
  it('starts at the given instant and does not move by itself', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.123Z');
    expect(clock.now().toISOString()).toBe('2026-10-09T10:00:00.123Z');
    expect(clock.now().toISOString()).toBe('2026-10-09T10:00:00.123Z');
  });

  it('advances by milliseconds and seconds', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.000Z');
    clock.advance(1);
    clock.advanceSeconds(2);
    expect(clock.now().toISOString()).toBe('2026-10-09T10:00:02.001Z');
  });

  it('can be set to an absolute instant', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.000Z');
    clock.set(new Date('2026-10-10T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });

  it('returns copies so callers cannot mutate the clock', () => {
    const clock = new FakeClock('2026-10-09T10:00:00.000Z');
    clock.now().setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});
```

`packages/testing/src/wait-for.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { waitFor } from './wait-for.js';

describe('waitFor', () => {
  it('resolves as soon as the predicate becomes true', async () => {
    let calls = 0;
    await waitFor(() => ++calls >= 3, { intervalMs: 5, timeoutMs: 1000 });
    expect(calls).toBe(3);
  });

  it('supports async predicates', async () => {
    let ready = false;
    setTimeout(() => (ready = true), 20);
    await waitFor(async () => ready, { intervalMs: 5, timeoutMs: 1000 });
    expect(ready).toBe(true);
  });

  it('throws when the predicate never becomes true', async () => {
    await expect(waitFor(() => false, { intervalMs: 5, timeoutMs: 50 })).rejects.toThrow(
      /timed out/i,
    );
  });
});
```

`packages/testing/src/webhook-receiver.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebhookReceiver } from './webhook-receiver.js';

let receiver: WebhookReceiver;
beforeEach(async () => {
  receiver = await WebhookReceiver.start();
});
afterEach(async () => {
  await receiver.close();
});

const post = (body: string) =>
  fetch(receiver.url, { method: 'POST', headers: { 'x-test': '1' }, body });

describe('WebhookReceiver', () => {
  it('records headers and the raw body of every request', async () => {
    await post('{"a":1}');
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]?.body).toBe('{"a":1}');
    expect(receiver.received[0]?.headers['x-test']).toBe('1');
  });

  it('answers 200 by default and follows the queued statuses first', async () => {
    receiver.respondWith(500, 503);
    expect((await post('1')).status).toBe(500);
    expect((await post('2')).status).toBe(503);
    expect((await post('3')).status).toBe(200);
  });

  it('can change the default status', async () => {
    receiver.setDefaultStatus(410);
    expect((await post('1')).status).toBe(410);
  });

  it('can delay its answer', async () => {
    receiver.setDelay(80);
    const started = Date.now();
    await post('1');
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/testing`
Expected: FAIL (không resolve được các module).

- [ ] **Step 4: Cài các tiện ích không cần Docker**

`packages/testing/src/fake-clock.ts`:
```ts
export class FakeClock {
  #now: Date;

  constructor(start: Date | string) {
    this.#now = new Date(start);
  }

  now(): Date {
    return new Date(this.#now.getTime());
  }

  set(date: Date | string): void {
    this.#now = new Date(date);
  }

  advance(ms: number): void {
    this.#now = new Date(this.#now.getTime() + ms);
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }
}
```

`packages/testing/src/wait-for.ts`:
```ts
export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5000, intervalMs = 25 }: WaitForOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
```

`packages/testing/src/webhook-receiver.ts`:
```ts
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  headers: IncomingHttpHeaders;
  body: string;
}

/** Máy chủ HTTP giả đóng vai wallet: ghi lại mọi webhook và trả mã trạng thái điều khiển được. */
export class WebhookReceiver {
  readonly received: ReceivedWebhook[] = [];
  readonly url: string;
  #queue: number[] = [];
  #defaultStatus = 200;
  #delayMs = 0;
  #server: Server;

  private constructor(server: Server, url: string) {
    this.#server = server;
    this.url = url;
  }

  static async start(): Promise<WebhookReceiver> {
    let receiver: WebhookReceiver | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receiver?.received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const status = receiver?.nextStatus() ?? 200;
        const delay = receiver?.delay() ?? 0;
        setTimeout(() => res.writeHead(status).end(), delay);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    receiver = new WebhookReceiver(server, `http://127.0.0.1:${port}/webhooks`);
    return receiver;
  }

  respondWith(...statuses: number[]): this {
    this.#queue.push(...statuses);
    return this;
  }

  setDefaultStatus(status: number): this {
    this.#defaultStatus = status;
    return this;
  }

  setDelay(ms: number): this {
    this.#delayMs = ms;
    return this;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  private nextStatus(): number {
    return this.#queue.shift() ?? this.#defaultStatus;
  }

  private delay(): number {
    return this.#delayMs;
  }
}
```

- [ ] **Step 5: Chạy lại test không cần Docker**

Run: `corepack pnpm exec vitest run packages/testing`
Expected: PASS.

- [ ] **Step 6: Cài phần SQL Server (global setup và `createTestDatabase`)**

`packages/testing/src/provided-context.ts`:
```ts
export interface SqlServerConnection {
  host: string;
  port: number;
  user: string;
  password: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    sqlServer: SqlServerConnection;
  }
}
```

`packages/testing/src/sql-server.global-setup.ts`:
```ts
import { MSSQLServerContainer } from '@testcontainers/mssqlserver';
import type { TestProject } from 'vitest/node';
import './provided-context.js';

const SA_PASSWORD = 'Str0ng!Passw0rd';

/** Khởi động một SQL Server 2022 dùng chung cho cả lượt chạy integration; mỗi test file tự tạo DB riêng. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
    .acceptLicense()
    .withPassword(SA_PASSWORD)
    .start();

  project.provide('sqlServer', {
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
  });

  return async () => {
    await container.stop();
  };
}
```

`packages/testing/src/sql-server.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { createDatabase, type DatabaseConfig } from '@billing/database';
import { sql } from 'kysely';
import { inject } from 'vitest';
import './provided-context.js';

export interface TestDatabase {
  config: DatabaseConfig;
  drop(): Promise<void>;
}

/** Tạo một database mới, tên ngẫu nhiên, trên SQL Server của testcontainers. */
export async function createTestDatabase(prefix = 'test'): Promise<TestDatabase> {
  const server = inject('sqlServer');
  const name = `${prefix}_${randomUUID().replaceAll('-', '')}`;
  const base = { host: server.host, port: server.port, user: server.user, password: server.password };

  const withAdmin = async (statement: string): Promise<void> => {
    const admin = createDatabase<unknown>({ ...base, database: 'master', poolMax: 1 });
    try {
      await sql.raw(statement).execute(admin);
    } finally {
      await admin.destroy();
    }
  };

  await withAdmin(`create database [${name}]`);

  return {
    config: { ...base, database: name, poolMax: 4 },
    drop: () =>
      withAdmin(`alter database [${name}] set single_user with rollback immediate; drop database [${name}]`),
  };
}
```

`packages/testing/src/index.ts`:
```ts
export { FakeClock } from './fake-clock.js';
export { createTestDatabase } from './sql-server.js';
export type { TestDatabase } from './sql-server.js';
export { WebhookReceiver } from './webhook-receiver.js';
export type { ReceivedWebhook } from './webhook-receiver.js';
export { waitFor } from './wait-for.js';
export type { WaitForOptions } from './wait-for.js';
```

- [ ] **Step 7: Cấu hình vitest tách unit và integration**

Sửa `vitest.config.ts`: đổi dòng `exclude: ['**/node_modules/**', '**/dist/**'],` thành
```ts
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
```

Tạo `vitest.integration.config.ts` ở gốc repo:
```ts
import { defineConfig } from 'vitest/config';

// Chạy các test cần Docker (SQL Server qua testcontainers). Một container dùng chung cho cả lượt chạy.
export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./packages/testing/src/sql-server.global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
```

Sửa `package.json` gốc: thêm dòng sau vào `scripts`, ngay dưới `"test:coverage": "vitest run --coverage",`:
```json
    "test:integration": "vitest run --config vitest.integration.config.ts",
```

- [ ] **Step 8: Viết integration test cho `@billing/database` (chứng minh các phát hiện về SQL Server)**

`packages/testing/src/database.integration.test.ts`:
```ts
import {
  createDatabase,
  dateTime,
  isUniqueViolation,
  migrate,
  toSafeInteger,
} from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './sql-server.js';

interface Schema {
  samples: { id: string; amount: string; due_at: Date };
}

let testDb: TestDatabase;
let db: Kysely<Schema>;

beforeAll(async () => {
  testDb = await createTestDatabase('database');
  db = createDatabase<Schema>(testDb.config);
  await sql`create table samples (id nvarchar(40) primary key, amount bigint not null, due_at datetime2(3) not null)`.execute(
    db,
  );
});

afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

describe('SQL Server access helpers', () => {
  it('keeps every millisecond when dates go through dateTime()', async () => {
    const instants = [
      '2026-10-09T10:00:00.001Z',
      '2026-10-09T10:00:00.004Z',
      '2026-10-09T10:00:00.999Z',
    ];
    for (const [index, iso] of instants.entries()) {
      await db
        .insertInto('samples')
        .values({ id: `d${index}`, amount: '1', due_at: dateTime(new Date(iso)) })
        .execute();
    }
    const rows = await db.selectFrom('samples').select('due_at').where('id', 'like', 'd%').orderBy('id').execute();
    expect(rows.map((r) => r.due_at.toISOString())).toEqual(instants);
  });

  it('returns bigint as a string that toSafeInteger converts', async () => {
    await sql`insert into samples values ('big', 9007199254740991, ${dateTime(new Date())})`.execute(db);
    const row = await db.selectFrom('samples').select('amount').where('id', '=', 'big').executeTakeFirstOrThrow();
    expect(typeof row.amount).toBe('string');
    expect(toSafeInteger(row.amount)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('exposes primary-key violations through isUniqueViolation', async () => {
    await db.insertInto('samples').values({ id: 'conflict', amount: '1', due_at: dateTime(new Date()) }).execute();
    const second = db.insertInto('samples').values({ id: 'conflict', amount: '1', due_at: dateTime(new Date()) }).execute();
    await expect(second).rejects.toSatisfy(isUniqueViolation);
  });

  it('applies migrations once and is a no-op the second time', async () => {
    const migrations = {
      '001_create_marker': {
        up: async (database: Kysely<unknown>) => {
          await sql`create table marker (id int primary key)`.execute(database);
        },
      },
    };
    expect(await migrate(db, migrations)).toEqual(['001_create_marker']);
    expect(await migrate(db, migrations)).toEqual([]);
  });
});
```

- [ ] **Step 9: Chạy integration test lần đầu**

Run: `corepack pnpm test:integration`
Expected: lần đầu kéo image `mcr.microsoft.com/mssql/server:2022-latest` (có thể vài phút), sau đó 4 test của `database.integration.test.ts` PASS. Nếu testcontainers báo lỗi khởi động "reaper" (Ryuk) trên máy, đặt `TESTCONTAINERS_RYUK_DISABLED=true` rồi chạy lại; ghi chú điều này vào README ở Task 13 nếu cần.

- [ ] **Step 10: Lint, typecheck, test unit, commit**

Run: `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test`
Expected: PASS (unit không đụng Docker).

```bash
git add packages/testing packages/database vitest.config.ts vitest.integration.config.ts package.json pnpm-lock.yaml
git commit -m "feat(testing): add testcontainers SQL Server harness, fake clock and webhook receiver"
```

### Task 3: Hợp đồng webhook trong `@billing/contracts`

**Files:**
- Create: `packages/contracts/src/ajv.ts`, `packages/contracts/src/webhook.ts`
- Modify: `packages/contracts/src/validate.ts` (viết lại toàn bộ), `src/emit.ts` (viết lại toàn bộ), `src/index.ts` (viết lại toàn bộ), `src/emit.test.ts` (một dòng)
- Test: `packages/contracts/src/webhook.test.ts`

**Interfaces:**
- Produces:
  - `ajv` (instance Ajv 2020 dùng chung, nội bộ package)
  - `chargeWebhookSchema`, `type ChargeWebhookPayload`
  - `validateChargeWebhook(raw: unknown): { ok: true; payload: ChargeWebhookPayload } | { ok: false; errors: string[] }` — ngoài schema còn kiểm tra nhất quán: `charge.succeeded` ⇒ `status SUCCEEDED` và không có `failureCode`; `charge.failed` ⇒ `status FAILED` và có `failureCode`
  - `signWebhook(secret: string, body: string, timestampSeconds: number): string` → `t=<unix>,v1=<hex>`
  - `verifyWebhook(input: { secret: string; body: string; header: string | undefined; nowSeconds: number; toleranceSeconds?: number }): { ok: true } | { ok: false; reason: 'MALFORMED' | 'EXPIRED' | 'MISMATCH' }` (mặc định `DEFAULT_TOLERANCE_SECONDS = 300`; kiểm tra chữ ký trước, hết hạn sau)

- [ ] **Step 1: Viết test thất bại**

`packages/contracts/src/webhook.test.ts`:
```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOLERANCE_SECONDS,
  signWebhook,
  validateChargeWebhook,
  verifyWebhook,
} from './index.js';

const secret = 'whsec_test_secret';
const body = '{"eventId":"evt_1","type":"charge.succeeded"}';
const now = 1_790_000_000;

describe('signWebhook', () => {
  it('produces t=<unix>,v1=<hmac> matching an independent HMAC-SHA256', () => {
    const expected = createHmac('sha256', secret).update(`${now}.${body}`).digest('hex');
    expect(signWebhook(secret, body, now)).toBe(`t=${now},v1=${expected}`);
  });
});

describe('verifyWebhook', () => {
  const header = signWebhook(secret, body, now);
  const verify = (overrides: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
    verifyWebhook({ secret, body, header, nowSeconds: now, ...overrides });

  it('accepts a correct signature', () => {
    expect(verify()).toEqual({ ok: true });
  });

  it('uses a default tolerance of 300 seconds, inclusive', () => {
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
    expect(verify({ nowSeconds: now + 300 })).toEqual({ ok: true });
    expect(verify({ nowSeconds: now - 300 })).toEqual({ ok: true });
    expect(verify({ nowSeconds: now + 301 })).toEqual({ ok: false, reason: 'EXPIRED' });
    expect(verify({ nowSeconds: now - 301 })).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('honours a custom tolerance', () => {
    expect(verify({ nowSeconds: now + 10, toleranceSeconds: 5 })).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('rejects a tampered body and a wrong secret', () => {
    expect(verify({ body: `${body} ` })).toEqual({ ok: false, reason: 'MISMATCH' });
    expect(verify({ secret: 'other' })).toEqual({ ok: false, reason: 'MISMATCH' });
  });

  it('reports MISMATCH, not EXPIRED, when both are wrong (no probing of the clock)', () => {
    expect(verify({ secret: 'other', nowSeconds: now + 10_000 })).toEqual({
      ok: false,
      reason: 'MISMATCH',
    });
  });

  it.each([
    undefined,
    '',
    'garbage',
    't=abc,v1=00',
    `t=${now}`,
    `v1=${'a'.repeat(64)}`,
    `t=${now},v1=${'g'.repeat(64)}`,
    `t=${now},v1=${'a'.repeat(63)}`,
  ])('rejects malformed header %j', (bad) => {
    expect(verify({ header: bad })).toEqual({ ok: false, reason: 'MALFORMED' });
  });
});

describe('validateChargeWebhook', () => {
  const succeeded = {
    eventId: 'evt_1',
    type: 'charge.succeeded',
    createdAt: '2026-10-09T10:00:01.000Z',
    data: {
      chargeId: 'ch_1',
      reference: 'topup-1',
      amount: 150000,
      currency: 'VND',
      status: 'SUCCEEDED',
      completedAt: '2026-10-09T10:00:01.000Z',
    },
  };
  const failed = {
    ...succeeded,
    type: 'charge.failed',
    data: { ...succeeded.data, status: 'FAILED', failureCode: 'card_declined' },
  };

  it('accepts a succeeded and a failed payload', () => {
    expect(validateChargeWebhook(succeeded).ok).toBe(true);
    expect(validateChargeWebhook(failed).ok).toBe(true);
  });

  it('tolerates unknown extra fields', () => {
    expect(validateChargeWebhook({ ...succeeded, future: 1, data: { ...succeeded.data, x: 2 } }).ok).toBe(true);
  });

  it.each([
    ['unknown type', { ...succeeded, type: 'charge.refunded' }],
    ['succeeded type with FAILED status', { ...succeeded, data: { ...succeeded.data, status: 'FAILED' } }],
    ['succeeded with a failureCode', { ...succeeded, data: { ...succeeded.data, failureCode: 'x' } }],
    ['failed type with SUCCEEDED status', { ...failed, data: { ...failed.data, status: 'SUCCEEDED' } }],
    ['failed without a failureCode', { ...failed, data: { ...failed.data, failureCode: undefined } }],
    ['bad failureCode', { ...failed, data: { ...failed.data, failureCode: 'Bad Code' } }],
    ['zero amount', { ...succeeded, data: { ...succeeded.data, amount: 0 } }],
    ['float amount', { ...succeeded, data: { ...succeeded.data, amount: 1.5 } }],
    ['unsupported currency', { ...succeeded, data: { ...succeeded.data, currency: 'EUR' } }],
    ['missing chargeId', { ...succeeded, data: { ...succeeded.data, chargeId: undefined } }],
    ['bad timestamp', { ...succeeded, createdAt: 'yesterday' }],
  ])('rejects %s', (_name, payload) => {
    expect(validateChargeWebhook(payload).ok).toBe(false);
  });

  it('rejects non-objects', () => {
    expect(validateChargeWebhook(null).ok).toBe(false);
    expect(validateChargeWebhook('x').ok).toBe(false);
  });
});
```

Sửa `packages/contracts/src/emit.test.ts`: đổi dòng
`expect(written).toHaveLength(1 + Object.keys(eventSchemas).length);`
thành
`expect(written).toHaveLength(2 + Object.keys(eventSchemas).length);`
và thêm ngay sau dòng `expect(envelope.$id).toBe('urn:billing:schema:envelope:v1');` một dòng:
```ts
    const webhook = JSON.parse(await readFile(join(dir, 'payment.charge-event.v1.json'), 'utf8'));
    expect(webhook.$id).toBe('urn:billing:schema:payment.charge-event:v1');
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/contracts`
Expected: FAIL (`webhook.test.ts` không resolve được export; `emit.test.ts` thất bại vì thiếu file).

- [ ] **Step 3: Tách Ajv dùng chung và cài webhook**

`packages/contracts/src/ajv.ts`:
```ts
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv và ajv-formats là CJS; tùy bundler/runtime mà default import là hàm hoặc { default }.
const unwrap = <T>(mod: T | { default: T }): T =>
  typeof mod === 'function' ? mod : (mod as { default: T }).default;

const Ajv2020 = unwrap(Ajv2020Module);
const addFormats = unwrap(addFormatsModule);

export const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
```

Viết lại toàn bộ `packages/contracts/src/validate.ts`:
```ts
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { ajv } from './ajv.js';
import { envelopeSchema, type Envelope } from './envelope.js';
import { eventSchemas, type EventType } from './events.js';

const validateEnvelope = ajv.compile(envelopeSchema);
const validateData = new Map<EventType, ValidateFunction>(
  (Object.keys(eventSchemas) as EventType[]).map((type) => [type, ajv.compile(eventSchemas[type])]),
);

export type ValidationResult =
  | { ok: true; type: EventType; message: Envelope<unknown> }
  | { ok: false; errors: string[] };

const describe = (fn: ValidateFunction): string[] =>
  (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);

export function validateMessage(raw: unknown): ValidationResult {
  if (!validateEnvelope(raw)) {
    return { ok: false, errors: describe(validateEnvelope) };
  }
  // Đã khớp envelopeSchema ở trên; kiểu ajv suy ra không tương thích với Envelope nên đi qua unknown.
  const message = raw as unknown as Envelope<unknown>;
  const dataValidator = validateData.get(message.type as EventType);
  if (!dataValidator) {
    return { ok: false, errors: [`UNKNOWN_TYPE ${message.type}`] };
  }
  if (!dataValidator(message.data)) {
    return { ok: false, errors: describe(dataValidator).map((e) => `data${e}`) };
  }
  return { ok: true, type: message.type as EventType, message };
}
```

`packages/contracts/src/webhook.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FromSchema } from 'json-schema-to-ts';
import { ajv } from './ajv.js';

export const DEFAULT_TOLERANCE_SECONDS = 300;

export const chargeWebhookSchema = {
  $id: 'urn:billing:schema:payment.charge-event:v1',
  type: 'object',
  required: ['eventId', 'type', 'createdAt', 'data'],
  properties: {
    eventId: { type: 'string', minLength: 1 },
    type: { type: 'string', enum: ['charge.succeeded', 'charge.failed'] },
    createdAt: { type: 'string', format: 'date-time' },
    data: {
      type: 'object',
      required: ['chargeId', 'reference', 'amount', 'currency', 'status', 'completedAt'],
      properties: {
        chargeId: { type: 'string', minLength: 1 },
        reference: { type: 'string', minLength: 1 },
        amount: { type: 'integer', minimum: 1 },
        currency: { type: 'string', enum: ['VND', 'USD'] },
        status: { type: 'string', enum: ['SUCCEEDED', 'FAILED'] },
        completedAt: { type: 'string', format: 'date-time' },
        failureCode: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' },
      },
    },
  },
} as const;

export type ChargeWebhookPayload = FromSchema<typeof chargeWebhookSchema>;

export type ChargeWebhookResult =
  | { ok: true; payload: ChargeWebhookPayload }
  | { ok: false; errors: string[] };

const validatePayload = ajv.compile(chargeWebhookSchema);

export function validateChargeWebhook(raw: unknown): ChargeWebhookResult {
  if (!validatePayload(raw)) {
    const errors = (validatePayload.errors ?? []).map(
      (e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`,
    );
    return { ok: false, errors };
  }
  const payload = raw as unknown as ChargeWebhookPayload;
  const errors: string[] = [];
  if (payload.type === 'charge.succeeded') {
    if (payload.data.status !== 'SUCCEEDED') errors.push('charge.succeeded requires status SUCCEEDED');
    if (payload.data.failureCode !== undefined) errors.push('charge.succeeded must not carry failureCode');
  } else {
    if (payload.data.status !== 'FAILED') errors.push('charge.failed requires status FAILED');
    if (payload.data.failureCode === undefined) errors.push('charge.failed requires failureCode');
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, payload };
}

export function signWebhook(secret: string, body: string, timestampSeconds: number): string {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: 'MALFORMED' | 'EXPIRED' | 'MISMATCH' };

export interface VerifyWebhookInput {
  secret: string;
  body: string;
  header: string | undefined;
  nowSeconds: number;
  toleranceSeconds?: number;
}

function parseHeader(header: string | undefined): { t: number; v1: string } | undefined {
  if (header === undefined) return undefined;
  const parts = new Map<string, string>();
  for (const part of header.split(',')) {
    const index = part.indexOf('=');
    if (index > 0) parts.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  const t = parts.get('t');
  const v1 = parts.get('v1');
  if (t === undefined || v1 === undefined) return undefined;
  if (!/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/i.test(v1)) return undefined;
  return { t: Number(t), v1 };
}

/** So chữ ký bằng timingSafeEqual; kiểm tra chữ ký trước rồi mới kiểm tra thời gian. */
export function verifyWebhook(input: VerifyWebhookInput): VerifyWebhookResult {
  const parsed = parseHeader(input.header);
  if (!parsed) return { ok: false, reason: 'MALFORMED' };

  const expected = createHmac('sha256', input.secret)
    .update(`${parsed.t}.${input.body}`)
    .digest();
  const actual = Buffer.from(parsed.v1, 'hex');
  if (!timingSafeEqual(actual, expected)) return { ok: false, reason: 'MISMATCH' };

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - parsed.t) > tolerance) return { ok: false, reason: 'EXPIRED' };
  return { ok: true };
}
```

Viết lại toàn bộ `packages/contracts/src/emit.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { envelopeSchema } from './envelope.js';
import { eventSchemas } from './events.js';
import { chargeWebhookSchema } from './webhook.js';

/** Ghi JSON Schema thành file để các bên (kể cả team ecommerce, C#) lấy làm hợp đồng. */
export async function emitSchemas(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: Array<[string, unknown]> = [
    ['envelope.v1.json', envelopeSchema],
    ['payment.charge-event.v1.json', chargeWebhookSchema],
    ...Object.entries(eventSchemas).map(([type, schema]): [string, unknown] => [
      `${type}.json`,
      schema,
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

Viết lại toàn bộ `packages/contracts/src/index.ts`:
```ts
export { envelopeSchema } from './envelope.js';
export type { Envelope } from './envelope.js';
export {
  eventSchemas,
  orderPaidV1,
  orderPaymentFailedV1,
  orderReadyForPaymentV1,
} from './events.js';
export type {
  EventType,
  OrderPaidV1,
  OrderPaymentFailedV1,
  OrderReadyForPaymentV1,
} from './events.js';
export { validateMessage } from './validate.js';
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

- [ ] **Step 4: Chạy test, lint, typecheck, thử lệnh emit**

```bash
corepack pnpm exec vitest run packages/contracts && corepack pnpm lint && corepack pnpm typecheck
corepack pnpm --filter @billing/contracts emit
```
Expected: PASS (toàn bộ test cũ của `validate.test.ts` vẫn đạt sau khi tách Ajv); lệnh emit in `wrote 5 schema files to dist/schemas`.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add charge webhook schema and HMAC signing/verification"
```

---

### Task 4: Domain — `Scenario`

**Files:**
- Create: `services/payment/src/domain/scenario.ts`
- Test: `services/payment/src/domain/scenario.test.ts`

**Interfaces:**
- Produces:
  - `interface Scenario { readonly fail: string | null; readonly delaySeconds: number | null; readonly webhook: 'normal' | 'drop' | 'duplicate'; readonly responseTimeout: boolean }` (luôn đủ bốn khóa theo đúng thứ tự này, để `JSON.stringify` ổn định khi băm)
  - `const DEFAULT_SCENARIO: Scenario`, `const MAX_DELAY_SECONDS = 3600`
  - `class InvalidScenarioError extends Error`
  - `parseScenario(header: string | undefined): Scenario`

- [ ] **Step 1: Viết test thất bại**

`services/payment/src/domain/scenario.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENARIO, InvalidScenarioError, parseScenario } from './scenario.js';

describe('parseScenario', () => {
  it.each([undefined, '', '   '])('returns the default scenario for %j', (header) => {
    expect(parseScenario(header)).toEqual({
      fail: null,
      delaySeconds: null,
      webhook: 'normal',
      responseTimeout: false,
    });
    expect(parseScenario(header)).toBe(DEFAULT_SCENARIO);
  });

  it('parses each token', () => {
    expect(parseScenario('fail=card_declined').fail).toBe('card_declined');
    expect(parseScenario('delay=5').delaySeconds).toBe(5);
    expect(parseScenario('delay=3600').delaySeconds).toBe(3600);
    expect(parseScenario('webhook=drop').webhook).toBe('drop');
    expect(parseScenario('webhook=duplicate').webhook).toBe('duplicate');
    expect(parseScenario('response=timeout').responseTimeout).toBe(true);
  });

  it('combines tokens regardless of order or spacing', () => {
    const a = parseScenario('delay=3,fail=insufficient_funds,webhook=duplicate');
    const b = parseScenario(' webhook=duplicate , fail=insufficient_funds,delay=3 ');
    expect(a).toEqual({
      fail: 'insufficient_funds',
      delaySeconds: 3,
      webhook: 'duplicate',
      responseTimeout: false,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it.each([
    'fail',
    'fail=',
    '=x',
    'x',
    ',',
    'fail=Bad',
    'fail=1abc',
    `fail=${'a'.repeat(65)}`,
    'delay=0',
    'delay=3601',
    'delay=1.5',
    'delay=abc',
    'delay=05',
    'delay=-1',
    'webhook=normal',
    'webhook=slow',
    'response=slow',
    'unknown=1',
    'fail=a,fail=b',
    'webhook=drop,webhook=duplicate',
  ])('rejects %j', (header) => {
    expect(() => parseScenario(header)).toThrow(InvalidScenarioError);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/payment/src/domain/scenario.test.ts`
Expected: FAIL (không resolve được `./scenario.js`).

- [ ] **Step 3: Cài code**

`services/payment/src/domain/scenario.ts`:
```ts
export interface Scenario {
  readonly fail: string | null;
  readonly delaySeconds: number | null;
  readonly webhook: 'normal' | 'drop' | 'duplicate';
  readonly responseTimeout: boolean;
}

export class InvalidScenarioError extends Error {
  override name = 'InvalidScenarioError';
}

export const MAX_DELAY_SECONDS = 3600;

export const DEFAULT_SCENARIO: Scenario = {
  fail: null,
  delaySeconds: null,
  webhook: 'normal',
  responseTimeout: false,
};

const FAIL_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DELAY = /^[1-9][0-9]{0,3}$/;

/** Phân tích header `X-Simulate`. Giá trị lạ, khóa lạ hay khóa lặp đều bị từ chối, không đoán. */
export function parseScenario(header: string | undefined): Scenario {
  if (header === undefined || header.trim() === '') return DEFAULT_SCENARIO;

  const seen = new Set<string>();
  let fail: string | null = null;
  let delaySeconds: number | null = null;
  let webhook: Scenario['webhook'] = 'normal';
  let responseTimeout = false;

  for (const rawToken of header.split(',')) {
    const token = rawToken.trim();
    const eq = token.indexOf('=');
    if (eq <= 0 || eq === token.length - 1) {
      throw new InvalidScenarioError(`malformed token "${token}", expected key=value`);
    }
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (seen.has(key)) throw new InvalidScenarioError(`duplicate key "${key}"`);
    seen.add(key);

    switch (key) {
      case 'fail':
        if (!FAIL_CODE.test(value)) {
          throw new InvalidScenarioError(`fail code "${value}" must match ${FAIL_CODE.source}`);
        }
        fail = value;
        break;
      case 'delay': {
        if (!DELAY.test(value) || Number(value) > MAX_DELAY_SECONDS) {
          throw new InvalidScenarioError(`delay must be an integer in 1..${MAX_DELAY_SECONDS}`);
        }
        delaySeconds = Number(value);
        break;
      }
      case 'webhook':
        if (value !== 'drop' && value !== 'duplicate') {
          throw new InvalidScenarioError('webhook must be "drop" or "duplicate"');
        }
        webhook = value;
        break;
      case 'response':
        if (value !== 'timeout') throw new InvalidScenarioError('response must be "timeout"');
        responseTimeout = true;
        break;
      default:
        throw new InvalidScenarioError(`unknown key "${key}"`);
    }
  }

  return { fail, delaySeconds, webhook, responseTimeout };
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run services/payment/src/domain/scenario.test.ts && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/payment/src/domain
git commit -m "feat(payment): add X-Simulate scenario parser"
```

---

### Task 5: Domain — `Charge` và `WebhookEvent`

**Files:**
- Create: `services/payment/src/domain/errors.ts`, `charge.ts`, `webhook-event.ts`
- Test: `services/payment/src/domain/charge.test.ts`, `webhook-event.test.ts`

**Interfaces:**
- Consumes: `Scenario` từ Task 4; `Money` từ `@billing/money`.
- Produces:
  - `class InvalidChargeError extends Error`, `class StateTransitionError extends Error`
  - `type ChargeStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED'`
  - `interface ChargeProps { id: string; reference: string; amount: Money; status: ChargeStatus; failureCode: string | null; scenario: Scenario; dueAt: Date; createdAt: Date; completedAt: Date | null }` (mọi trường `readonly`)
  - `class Charge` với `static create(input: { id: string; reference: string; amount: Money; scenario: Scenario; now: Date }): Charge` (ném `InvalidChargeError`), `static rehydrate(props: ChargeProps): Charge`, `isDue(now: Date): boolean`, `complete(now: Date): Charge` (ném `StateTransitionError` nếu không `PENDING` hoặc chưa đến hạn), `toProps(): ChargeProps`; hằng `MAX_REFERENCE_LENGTH = 200`
  - `type WebhookEventType = 'charge.succeeded' | 'charge.failed'`, `type WebhookEventStatus = 'PENDING' | 'DELIVERED' | 'FAILED'`
  - `interface WebhookEventProps { eventId: string; chargeId: string; type: WebhookEventType; payload: string; status: WebhookEventStatus; attempts: number; nextAttemptAt: Date | null; sendTwice: boolean; createdAt: Date; deliveredAt: Date | null }`
  - `class WebhookEvent` với `static forCharge(charge: Charge, eventId: string, now: Date): WebhookEvent`, `static rehydrate(props)`, `isDue(now)`, `claim(now, leaseSeconds)`, `recordSuccess(now)`, `recordFailure(now, backoffSeconds: readonly number[])`, `toProps()`; mọi hàm đổi trạng thái ném `StateTransitionError` nếu sự kiện không `PENDING`
  - `payload` là chuỗi JSON: `{ eventId, type, createdAt, data: { chargeId, reference, amount, currency, status, completedAt, failureCode? } }`

- [ ] **Step 1: Viết test thất bại**

`services/payment/src/domain/charge.test.ts`:
```ts
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { Charge, MAX_REFERENCE_LENGTH } from './charge.js';
import { InvalidChargeError, StateTransitionError } from './errors.js';
import { DEFAULT_SCENARIO, parseScenario } from './scenario.js';

const now = new Date('2026-10-09T10:00:00.000Z');
const base = {
  id: 'ch_1',
  reference: 'topup-1',
  amount: Money.of(150000, 'VND'),
  scenario: DEFAULT_SCENARIO,
  now,
};

describe('Charge.create', () => {
  it('starts PENDING and is due immediately', () => {
    const charge = Charge.create(base);
    expect(charge.toProps()).toMatchObject({
      id: 'ch_1',
      reference: 'topup-1',
      status: 'PENDING',
      failureCode: null,
      completedAt: null,
    });
    expect(charge.toProps().dueAt).toEqual(now);
    expect(charge.toProps().createdAt).toEqual(now);
    expect(charge.isDue(now)).toBe(true);
  });

  it('is due only after the scenario delay', () => {
    const charge = Charge.create({ ...base, scenario: parseScenario('delay=5') });
    expect(charge.toProps().dueAt).toEqual(new Date('2026-10-09T10:00:05.000Z'));
    expect(charge.isDue(new Date('2026-10-09T10:00:04.999Z'))).toBe(false);
    expect(charge.isDue(new Date('2026-10-09T10:00:05.000Z'))).toBe(true);
  });

  it.each(['', '   ', 'x'.repeat(MAX_REFERENCE_LENGTH + 1)])('rejects reference %j', (reference) => {
    expect(() => Charge.create({ ...base, reference })).toThrow(InvalidChargeError);
  });

  it('accepts a reference of exactly the maximum length', () => {
    expect(() => Charge.create({ ...base, reference: 'x'.repeat(MAX_REFERENCE_LENGTH) })).not.toThrow();
  });

  it.each([0, -1])('rejects amount %d', (amount) => {
    expect(() => Charge.create({ ...base, amount: Money.of(amount, 'VND') })).toThrow(
      InvalidChargeError,
    );
  });
});

describe('Charge.complete', () => {
  it('succeeds by default and leaves the original untouched', () => {
    const charge = Charge.create(base);
    const later = new Date('2026-10-09T10:00:01.000Z');
    const done = charge.complete(later);
    expect(done.toProps()).toMatchObject({ status: 'SUCCEEDED', failureCode: null, completedAt: later });
    expect(charge.toProps().status).toBe('PENDING');
  });

  it('fails with the scenario failure code', () => {
    const charge = Charge.create({ ...base, scenario: parseScenario('fail=card_declined') });
    expect(charge.complete(now).toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
      completedAt: now,
    });
  });

  it('cannot complete before it is due', () => {
    const charge = Charge.create({ ...base, scenario: parseScenario('delay=5') });
    expect(() => charge.complete(now)).toThrow(StateTransitionError);
  });

  it('cannot complete twice', () => {
    const done = Charge.create(base).complete(now);
    expect(() => done.complete(now)).toThrow(StateTransitionError);
    expect(done.isDue(now)).toBe(false);
  });
});
```

`services/payment/src/domain/webhook-event.test.ts`:
```ts
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { Charge } from './charge.js';
import { StateTransitionError } from './errors.js';
import { DEFAULT_SCENARIO, parseScenario } from './scenario.js';
import { WebhookEvent } from './webhook-event.js';

const t0 = new Date('2026-10-09T10:00:00.000Z');
const plus = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);

function completedCharge(simulate?: string) {
  const scenario = simulate ? parseScenario(simulate) : DEFAULT_SCENARIO;
  return Charge.create({
    id: 'ch_1',
    reference: 'topup-1',
    amount: Money.of(150000, 'VND'),
    scenario,
    now: t0,
  }).complete(t0);
}

describe('WebhookEvent.forCharge', () => {
  it('builds a charge.succeeded payload', () => {
    const event = WebhookEvent.forCharge(completedCharge(), 'evt_1', t0);
    const props = event.toProps();
    expect(props).toMatchObject({
      eventId: 'evt_1',
      chargeId: 'ch_1',
      type: 'charge.succeeded',
      status: 'PENDING',
      attempts: 0,
      sendTwice: false,
      deliveredAt: null,
    });
    expect(props.nextAttemptAt).toEqual(t0);
    expect(JSON.parse(props.payload)).toEqual({
      eventId: 'evt_1',
      type: 'charge.succeeded',
      createdAt: '2026-10-09T10:00:00.000Z',
      data: {
        chargeId: 'ch_1',
        reference: 'topup-1',
        amount: 150000,
        currency: 'VND',
        status: 'SUCCEEDED',
        completedAt: '2026-10-09T10:00:00.000Z',
      },
    });
  });

  it('builds a charge.failed payload with the failure code', () => {
    const event = WebhookEvent.forCharge(completedCharge('fail=card_declined'), 'evt_2', t0);
    expect(event.toProps().type).toBe('charge.failed');
    expect(JSON.parse(event.toProps().payload).data).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
    });
  });

  it('marks the event to be sent twice for webhook=duplicate', () => {
    const event = WebhookEvent.forCharge(completedCharge('webhook=duplicate'), 'evt_3', t0);
    expect(event.toProps().sendTwice).toBe(true);
  });

  it('refuses a charge that is not completed', () => {
    const pending = Charge.create({
      id: 'ch_9',
      reference: 'r',
      amount: Money.of(1, 'VND'),
      scenario: DEFAULT_SCENARIO,
      now: t0,
    });
    expect(() => WebhookEvent.forCharge(pending, 'evt_9', t0)).toThrow(StateTransitionError);
  });
});

describe('WebhookEvent lifecycle', () => {
  const fresh = () => WebhookEvent.forCharge(completedCharge(), 'evt_1', t0);

  it('is due at its nextAttemptAt', () => {
    expect(fresh().isDue(t0)).toBe(true);
    expect(fresh().isDue(new Date(t0.getTime() - 1))).toBe(false);
  });

  it('claim() pushes the next attempt out by the lease without counting an attempt', () => {
    const claimed = fresh().claim(t0, 60);
    expect(claimed.toProps()).toMatchObject({ status: 'PENDING', attempts: 0 });
    expect(claimed.toProps().nextAttemptAt).toEqual(plus(t0, 60));
    expect(claimed.isDue(plus(t0, 59))).toBe(false);
    expect(claimed.isDue(plus(t0, 60))).toBe(true);
  });

  it('recordSuccess() delivers the event', () => {
    const done = fresh().recordSuccess(plus(t0, 1));
    expect(done.toProps()).toMatchObject({
      status: 'DELIVERED',
      attempts: 1,
      nextAttemptAt: null,
      deliveredAt: plus(t0, 1),
    });
  });

  it('recordFailure() follows the backoff, then gives up (1 first try + len(backoff) retries)', () => {
    const backoff = [1, 5];
    const first = fresh().recordFailure(plus(t0, 10), backoff);
    expect(first.toProps()).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(first.toProps().nextAttemptAt).toEqual(plus(t0, 11));

    const second = first.recordFailure(plus(t0, 20), backoff);
    expect(second.toProps()).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(second.toProps().nextAttemptAt).toEqual(plus(t0, 25));

    const third = second.recordFailure(plus(t0, 30), backoff);
    expect(third.toProps()).toMatchObject({ status: 'FAILED', attempts: 3, nextAttemptAt: null });
  });

  it('gives up right away when the backoff list is empty', () => {
    expect(fresh().recordFailure(t0, []).toProps().status).toBe('FAILED');
  });

  it.each(['claim', 'recordSuccess', 'recordFailure'] as const)(
    '%s() is rejected once the event is no longer PENDING',
    (method) => {
      const delivered = fresh().recordSuccess(t0);
      const call = () => {
        if (method === 'claim') delivered.claim(t0, 60);
        else if (method === 'recordSuccess') delivered.recordSuccess(t0);
        else delivered.recordFailure(t0, [1]);
      };
      expect(call).toThrow(StateTransitionError);
    },
  );
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/payment/src/domain`
Expected: FAIL (không resolve được `./charge.js`, `./errors.js`, `./webhook-event.js`).

- [ ] **Step 3: Cài code**

`services/payment/src/domain/errors.ts`:
```ts
export class InvalidChargeError extends Error {
  override name = 'InvalidChargeError';
}

export class StateTransitionError extends Error {
  override name = 'StateTransitionError';
}
```

`services/payment/src/domain/charge.ts`:
```ts
import type { Money } from '@billing/money';
import { InvalidChargeError, StateTransitionError } from './errors.js';
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

`services/payment/src/domain/webhook-event.ts`:
```ts
import type { Charge } from './charge.js';
import { StateTransitionError } from './errors.js';

export type WebhookEventType = 'charge.succeeded' | 'charge.failed';
export type WebhookEventStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

export interface WebhookEventProps {
  readonly eventId: string;
  readonly chargeId: string;
  readonly type: WebhookEventType;
  readonly payload: string;
  readonly status: WebhookEventStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly sendTwice: boolean;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}

const addSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

export class WebhookEvent {
  private constructor(private readonly props: WebhookEventProps) {}

  static forCharge(charge: Charge, eventId: string, now: Date): WebhookEvent {
    const c = charge.toProps();
    if (c.status === 'PENDING' || c.completedAt === null) {
      throw new StateTransitionError(`charge ${c.id} is not completed`);
    }
    const type: WebhookEventType = c.status === 'SUCCEEDED' ? 'charge.succeeded' : 'charge.failed';
    const payload = JSON.stringify({
      eventId,
      type,
      createdAt: now.toISOString(),
      data: {
        chargeId: c.id,
        reference: c.reference,
        amount: c.amount.amount,
        currency: c.amount.currency,
        status: c.status,
        completedAt: c.completedAt.toISOString(),
        ...(c.failureCode === null ? {} : { failureCode: c.failureCode }),
      },
    });
    return new WebhookEvent({
      eventId,
      chargeId: c.id,
      type,
      payload,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      sendTwice: c.scenario.webhook === 'duplicate',
      createdAt: now,
      deliveredAt: null,
    });
  }

  static rehydrate(props: WebhookEventProps): WebhookEvent {
    return new WebhookEvent(props);
  }

  isDue(now: Date): boolean {
    return (
      this.props.status === 'PENDING' &&
      this.props.nextAttemptAt !== null &&
      this.props.nextAttemptAt.getTime() <= now.getTime()
    );
  }

  /** Chiếm sự kiện để gửi: đẩy lịch lên sau `leaseSeconds`, chưa tính là một lần thử. */
  claim(now: Date, leaseSeconds: number): WebhookEvent {
    this.assertPending();
    return new WebhookEvent({ ...this.props, nextAttemptAt: addSeconds(now, leaseSeconds) });
  }

  recordSuccess(now: Date): WebhookEvent {
    this.assertPending();
    return new WebhookEvent({
      ...this.props,
      status: 'DELIVERED',
      attempts: this.props.attempts + 1,
      nextAttemptAt: null,
      deliveredAt: now,
    });
  }

  /**
   * Lần gửi đầu + tối đa `backoffSeconds.length` lần retry. Thất bại thứ n (n <= độ dài) hẹn lại sau
   * `backoffSeconds[n-1]` giây; vượt quá thì `FAILED` và giữ lại để điều tra.
   */
  recordFailure(now: Date, backoffSeconds: readonly number[]): WebhookEvent {
    this.assertPending();
    const attempts = this.props.attempts + 1;
    const delay = backoffSeconds[attempts - 1];
    if (delay === undefined) {
      return new WebhookEvent({ ...this.props, status: 'FAILED', attempts, nextAttemptAt: null });
    }
    return new WebhookEvent({ ...this.props, attempts, nextAttemptAt: addSeconds(now, delay) });
  }

  toProps(): WebhookEventProps {
    return { ...this.props };
  }

  private assertPending(): void {
    if (this.props.status !== 'PENDING') {
      throw new StateTransitionError(`webhook event ${this.props.eventId} is ${this.props.status}`);
    }
  }
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run services/payment/src/domain && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS; lint xác nhận `domain` chỉ import `@billing/money` và file cùng lớp.

- [ ] **Step 5: Commit**

```bash
git add services/payment/src/domain
git commit -m "feat(payment): add Charge state machine and WebhookEvent lifecycle"
```

### Task 6: Migration, port ứng dụng, repository Kysely và unit of work

**Files:**
- Create: `db/payment/001-init.ts`, `db/payment/migrations.ts`, `db/payment/migrate.ts`
- Create: `services/payment/src/application/errors.ts`, `application/ports.ts`
- Create: `services/payment/src/infrastructure/kysely/schema.ts`, `mappers.ts`, `charge.repository.ts`, `idempotency.repository.ts`, `webhook.repository.ts`, `unit-of-work.ts`
- Create: `services/payment/src/test-support.ts`
- Modify: `package.json` (gốc), `services/payment/package.json` (qua lệnh pnpm)
- Test: `db/payment/migrations.integration.test.ts`, `services/payment/src/infrastructure/kysely/repositories.integration.test.ts`

**Interfaces:**
- Consumes: `Charge`, `WebhookEvent` (Task 5); `createDatabase`, `dateTime`, `toSafeInteger`, `isUniqueViolation`, `migrate` (Task 1); `createTestDatabase`, `FakeClock` (Task 2).
- Produces (application):
  - `interface Clock { now(): Date }`, `interface IdGenerator { chargeId(): string; eventId(): string }`
  - `class DuplicateKeyError`, `class IdempotencyConflictError`, `class ChargeNotFoundError`, `class InvalidSettlementQueryError` (đều `extends Error`)
  - `interface ChargeRepository { insert(charge): Promise<void>; findById(id): Promise<Charge | null>; lockDue(now: Date, limit: number): Promise<Charge[]>; save(charge): Promise<void>; listCompleted(query: { from: Date; to: Date; limit: number; after: CompletedCursor | null }): Promise<Charge[]>; totals(range: { from: Date; to: Date }): Promise<SettlementTotal[]> }`
  - `interface CompletedCursor { completedAt: Date; id: string }`; `interface SettlementTotal { currency: string; status: 'SUCCEEDED' | 'FAILED'; count: number; totalAmount: number }`
  - `interface StoredResponse { key: string; requestHash: string; responseStatus: number; responseBody: string; chargeId: string; createdAt: Date }`; `interface IdempotencyStore { find(key: string): Promise<StoredResponse | null>; save(record: StoredResponse): Promise<void> }` (`save` ném `DuplicateKeyError` khi trùng khóa)
  - `interface WebhookAttemptRecord { eventId: string; attemptNo: number; attemptedAt: Date; statusCode: number | null; error: string | null }`; `interface WebhookOutbox { add(event): Promise<void>; lockDue(now: Date, limit: number): Promise<WebhookEvent[]>; save(event): Promise<void>; recordAttempt(attempt: WebhookAttemptRecord): Promise<void> }`
  - `interface WebhookSendResult { ok: boolean; statusCode?: number; error?: string }`; `interface WebhookSender { send(event: WebhookEvent, now: Date): Promise<WebhookSendResult> }`
  - `interface Repositories { charges: ChargeRepository; idempotency: IdempotencyStore; webhooks: WebhookOutbox }`; `interface UnitOfWork { run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> }`
- Produces (infrastructure): `PaymentDatabase` (kiểu bảng), `KyselyChargeRepository`, `KyselyIdempotencyStore`, `KyselyWebhookOutbox`, `KyselyUnitOfWork(db: Kysely<PaymentDatabase>)`
- Produces (test): `createHarness(start?: string): Promise<Harness>` với `interface Harness { db: Kysely<PaymentDatabase>; clock: FakeClock; ids: SequentialIds; uow: KyselyUnitOfWork; close(): Promise<void> }`; `resetTables(db): Promise<void>`; `class SequentialIds implements IdGenerator` (`ch_000001`, `evt_000001`, …)
- Lệnh: `corepack pnpm db:migrate:payment` (đọc `PAYMENT_DB_*` từ môi trường)

- [ ] **Step 1: Cài phụ thuộc**

```bash
corepack pnpm --filter @billing/payment-service add kysely @billing/database@workspace:* @billing/money@workspace:* @billing/contracts@workspace:*
corepack pnpm --filter @billing/payment-service add -D @billing/testing@workspace:*
corepack pnpm add -D -w @billing/database@workspace:* @billing/testing@workspace:* kysely
```
Expected: không lỗi. (Gốc repo cần `kysely`, `@billing/database` và `@billing/testing` vì `db/payment/*.ts` — gồm cả test migration — nằm ngoài các package.)

Thêm vào `scripts` của `package.json` gốc, dưới `"test:integration"`:
```json
    "db:migrate:payment": "tsx db/payment/migrate.ts",
```

- [ ] **Step 2: Viết test migration thất bại**

`db/payment/migrations.integration.test.ts`:
```ts
import { createDatabase, dateTime, migrate } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { paymentMigrations } from './migrations.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;

beforeAll(async () => {
  testDb = await createTestDatabase('migrations');
  db = createDatabase<unknown>(testDb.config);
});

afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

describe('payment migrations', () => {
  it('apply once and are a no-op the second time', async () => {
    expect(await migrate(db, paymentMigrations)).toEqual(['001-init']);
    expect(await migrate(db, paymentMigrations)).toEqual([]);
  });

  it('create the four tables', async () => {
    const result = await sql<{ name: string }>`select name from sys.tables`.execute(db);
    expect(result.rows.map((r) => r.name)).toEqual(
      expect.arrayContaining(['charges', 'idempotency_keys', 'webhook_events', 'webhook_attempts']),
    );
  });

  it('create the indexes the worker relies on for READPAST and the settlement paging', async () => {
    const result = await sql<{ name: string }>`
      select name from sys.indexes
      where name in ('ix_charges_due', 'ix_charges_completed', 'ix_webhook_due')`.execute(db);
    expect(result.rows.map((r) => r.name).sort()).toEqual([
      'ix_charges_completed',
      'ix_charges_due',
      'ix_webhook_due',
    ]);
  });

  it.each([
    ['a zero amount', 0, 'PENDING'],
    ['a negative amount', -5, 'PENDING'],
    ['an unknown status', 1, 'WEIRD'],
  ])('reject %s with a CHECK constraint violation', async (_name, amount, status) => {
    const now = dateTime(new Date());
    const insert = sql`
      insert into charges (id, reference, amount, currency, status, scenario, due_at, created_at)
      values (${`c-${amount}-${status}`}, ${'r'}, ${amount}, ${'VND'}, ${status}, ${'{}'}, ${now}, ${now})`.execute(db);
    await expect(insert).rejects.toMatchObject({ number: 547 });
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration db/payment`
Expected: FAIL (không resolve được `./migrations.js`).

- [ ] **Step 4: Viết migration và script**

`db/payment/001-init.ts`:
```ts
import { sql, type Kysely } from 'kysely';

// Index (status, due_at, id) và (status, next_attempt_at, event_id) là BẮT BUỘC: không có chúng,
// `top (n) ... order by ... with (updlock, readpast)` quét và khóa mọi hàng nên worker thứ hai nhận về rỗng.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table charges (
      id nvarchar(64) not null primary key,
      reference nvarchar(200) not null,
      amount bigint not null,
      currency nvarchar(3) not null,
      status nvarchar(16) not null,
      failure_code nvarchar(64) null,
      scenario nvarchar(max) not null,
      due_at datetime2(3) not null,
      created_at datetime2(3) not null,
      completed_at datetime2(3) null,
      constraint ck_charges_amount check (amount > 0),
      constraint ck_charges_status check (status in ('PENDING', 'SUCCEEDED', 'FAILED')),
      constraint ck_charges_currency check (currency in ('VND', 'USD'))
    )`.execute(db);
  await sql`create index ix_charges_due on charges (status, due_at, id)`.execute(db);
  await sql`create index ix_charges_completed on charges (completed_at, id)`.execute(db);

  await sql`
    create table idempotency_keys (
      idempotency_key nvarchar(255) not null primary key,
      request_hash nvarchar(64) not null,
      response_status int not null,
      response_body nvarchar(max) not null,
      charge_id nvarchar(64) not null references charges (id),
      created_at datetime2(3) not null
    )`.execute(db);

  await sql`
    create table webhook_events (
      event_id nvarchar(64) not null primary key,
      charge_id nvarchar(64) not null references charges (id),
      event_type nvarchar(32) not null,
      payload nvarchar(max) not null,
      status nvarchar(16) not null,
      attempts int not null,
      next_attempt_at datetime2(3) null,
      send_twice bit not null,
      created_at datetime2(3) not null,
      delivered_at datetime2(3) null,
      constraint ck_webhook_events_status check (status in ('PENDING', 'DELIVERED', 'FAILED'))
    )`.execute(db);
  await sql`create index ix_webhook_due on webhook_events (status, next_attempt_at, event_id)`.execute(db);

  await sql`
    create table webhook_attempts (
      event_id nvarchar(64) not null references webhook_events (event_id),
      attempt_no int not null,
      attempted_at datetime2(3) not null,
      status_code int null,
      error_message nvarchar(500) null,
      primary key (event_id, attempt_no)
    )`.execute(db);
}
```

`db/payment/migrations.ts`:
```ts
import type { Migration } from '@billing/database';
import * as init from './001-init.js';

/** Tên migration quyết định thứ tự chạy; chỉ thêm mới, không sửa migration đã phát hành. */
export const paymentMigrations: Record<string, Migration> = {
  '001-init': init,
};
```

`db/payment/migrate.ts`:
```ts
import { ConfigError, createDatabase, databaseConfigFromEnv, migrate } from '@billing/database';
import { paymentMigrations } from './migrations.js';

try {
  const config = databaseConfigFromEnv('PAYMENT_DB', process.env);
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

- [ ] **Step 5: Chạy test migration**

Run: `corepack pnpm test:integration db/payment`
Expected: PASS (5 test, kể cả 3 ca CHECK).

- [ ] **Step 6: Viết port, lỗi ứng dụng và kiểu bảng**

`services/payment/src/application/errors.ts`:
```ts
/** Do `IdempotencyStore.save` ném khi khóa đã tồn tại (hai request đồng thời cùng key). */
export class DuplicateKeyError extends Error {
  override name = 'DuplicateKeyError';
}

export class IdempotencyConflictError extends Error {
  override name = 'IdempotencyConflictError';
}

export class ChargeNotFoundError extends Error {
  override name = 'ChargeNotFoundError';
}

export class InvalidSettlementQueryError extends Error {
  override name = 'InvalidSettlementQueryError';
}
```

`services/payment/src/application/ports.ts`:
```ts
import type { Charge } from '../domain/charge.js';
import type { WebhookEvent } from '../domain/webhook-event.js';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  chargeId(): string;
  eventId(): string;
}

export interface CompletedCursor {
  completedAt: Date;
  id: string;
}

export interface SettlementTotal {
  currency: string;
  status: 'SUCCEEDED' | 'FAILED';
  count: number;
  totalAmount: number;
}

export interface ChargeRepository {
  insert(charge: Charge): Promise<void>;
  findById(id: string): Promise<Charge | null>;
  /** Chọn charge PENDING đã đến hạn và khóa chúng (bỏ qua hàng đang bị khóa bởi worker khác). */
  lockDue(now: Date, limit: number): Promise<Charge[]>;
  save(charge: Charge): Promise<void>;
  listCompleted(query: {
    from: Date;
    to: Date;
    limit: number;
    after: CompletedCursor | null;
  }): Promise<Charge[]>;
  totals(range: { from: Date; to: Date }): Promise<SettlementTotal[]>;
}

export interface StoredResponse {
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: string;
  chargeId: string;
  createdAt: Date;
}

export interface IdempotencyStore {
  find(key: string): Promise<StoredResponse | null>;
  /** Ném `DuplicateKeyError` nếu khóa đã tồn tại. */
  save(record: StoredResponse): Promise<void>;
}

export interface WebhookAttemptRecord {
  eventId: string;
  attemptNo: number;
  attemptedAt: Date;
  statusCode: number | null;
  error: string | null;
}

export interface WebhookOutbox {
  add(event: WebhookEvent): Promise<void>;
  /** Chọn sự kiện PENDING đã đến hạn và khóa chúng (bỏ qua hàng đang bị khóa). */
  lockDue(now: Date, limit: number): Promise<WebhookEvent[]>;
  save(event: WebhookEvent): Promise<void>;
  recordAttempt(attempt: WebhookAttemptRecord): Promise<void>;
}

export interface WebhookSendResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export interface WebhookSender {
  send(event: WebhookEvent, now: Date): Promise<WebhookSendResult>;
}

export interface Repositories {
  charges: ChargeRepository;
  idempotency: IdempotencyStore;
  webhooks: WebhookOutbox;
}

export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
```

`services/payment/src/infrastructure/kysely/schema.ts`:
```ts
import type { ColumnType } from 'kysely';

export interface ChargesTable {
  id: string;
  reference: string;
  /** bigint: tedious trả về chuỗi khi đọc; ghi bằng number. */
  amount: ColumnType<string, number, number>;
  currency: string;
  status: string;
  failure_code: string | null;
  scenario: string;
  due_at: Date;
  created_at: Date;
  completed_at: Date | null;
}

export interface IdempotencyKeysTable {
  idempotency_key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  charge_id: string;
  created_at: Date;
}

export interface WebhookEventsTable {
  event_id: string;
  charge_id: string;
  event_type: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: Date | null;
  send_twice: boolean;
  created_at: Date;
  delivered_at: Date | null;
}

export interface WebhookAttemptsTable {
  event_id: string;
  attempt_no: number;
  attempted_at: Date;
  status_code: number | null;
  error_message: string | null;
}

export interface PaymentDatabase {
  charges: ChargesTable;
  idempotency_keys: IdempotencyKeysTable;
  webhook_events: WebhookEventsTable;
  webhook_attempts: WebhookAttemptsTable;
}
```

- [ ] **Step 7: Viết test repository thất bại**

`services/payment/src/infrastructure/kysely/repositories.integration.test.ts`:
```ts
import { Money } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DuplicateKeyError } from '../../application/errors.js';
import { Charge } from '../../domain/charge.js';
import { parseScenario } from '../../domain/scenario.js';
import { WebhookEvent } from '../../domain/webhook-event.js';
import { createHarness, resetTables, type Harness } from '../../test-support.js';

const t0 = new Date('2026-10-09T10:00:00.000Z');
const plus = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

function makeCharge(
  id: string,
  options: { simulate?: string; now?: Date; amount?: number; currency?: 'VND' | 'USD' } = {},
): Charge {
  return Charge.create({
    id,
    reference: `ref-${id}`,
    amount: Money.of(options.amount ?? 1000, options.currency ?? 'VND'),
    scenario: parseScenario(options.simulate),
    now: options.now ?? t0,
  });
}

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
});

describe('KyselyChargeRepository', () => {
  it('round-trips a charge including milliseconds, a bigint amount and the scenario', async () => {
    const charge = makeCharge('ch_a', {
      amount: Number.MAX_SAFE_INTEGER,
      currency: 'USD',
      now: new Date('2026-10-09T10:00:00.001Z'),
      simulate: 'fail=card_declined,delay=2,webhook=duplicate',
    });
    await h.uow.run(({ charges }) => charges.insert(charge));
    const loaded = await h.uow.run(({ charges }) => charges.findById('ch_a'));
    expect(loaded?.toProps()).toEqual(charge.toProps());
  });

  it('returns null for an unknown id', async () => {
    expect(await h.uow.run(({ charges }) => charges.findById('nope'))).toBeNull();
  });

  it('lockDue() returns only due PENDING charges, ordered by (due_at, id), honouring the limit', async () => {
    await h.uow.run(async ({ charges }) => {
      await charges.insert(makeCharge('ch_c', { simulate: 'delay=10' }));
      await charges.insert(makeCharge('ch_b'));
      await charges.insert(makeCharge('ch_a'));
      const done = makeCharge('ch_d');
      await charges.insert(done);
      await charges.save(done.complete(t0));
    });
    const ids = (cs: Charge[]) => cs.map((c) => c.toProps().id);
    expect(ids(await h.uow.run(({ charges }) => charges.lockDue(plus(5), 10)))).toEqual(['ch_a', 'ch_b']);
    expect(ids(await h.uow.run(({ charges }) => charges.lockDue(plus(5), 1)))).toEqual(['ch_a']);
    expect(ids(await h.uow.run(({ charges }) => charges.lockDue(plus(10), 10)))).toEqual([
      'ch_a',
      'ch_b',
      'ch_c',
    ]);
  });

  it('lockDue() skips rows another open transaction already holds (READPAST)', async () => {
    await h.uow.run(async ({ charges }) => {
      await charges.insert(makeCharge('ch_a'));
      await charges.insert(makeCharge('ch_b'));
    });

    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let locked!: (ids: string[]) => void;
    const lockedIds = new Promise<string[]>((resolve) => (locked = resolve));

    const first = h.uow.run(async ({ charges }) => {
      const rows = await charges.lockDue(t0, 1);
      locked(rows.map((r) => r.toProps().id));
      await hold;
    });
    expect(await lockedIds).toEqual(['ch_a']);

    const second = await h.uow.run(({ charges }) => charges.lockDue(t0, 1));
    expect(second.map((r) => r.toProps().id)).toEqual(['ch_b']);

    release();
    await first;
  });

  it('save() persists completion', async () => {
    const charge = makeCharge('ch_a', { simulate: 'fail=card_declined' });
    await h.uow.run(({ charges }) => charges.insert(charge));
    await h.uow.run(({ charges }) => charges.save(charge.complete(plus(1))));
    const loaded = await h.uow.run(({ charges }) => charges.findById('ch_a'));
    expect(loaded?.toProps()).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
      completedAt: plus(1),
    });
  });
});

describe('KyselyIdempotencyStore', () => {
  const record = (key: string, chargeId: string) => ({
    key,
    requestHash: 'h'.repeat(64),
    responseStatus: 202,
    responseBody: '{"chargeId":"x"}',
    chargeId,
    createdAt: new Date('2026-10-09T10:00:00.123Z'),
  });

  it('stores and finds a response, and returns null for an unknown key', async () => {
    await h.uow.run(async ({ charges, idempotency }) => {
      await charges.insert(makeCharge('ch_a'));
      await idempotency.save(record('k1', 'ch_a'));
    });
    expect(await h.uow.run(({ idempotency }) => idempotency.find('k1'))).toEqual(record('k1', 'ch_a'));
    expect(await h.uow.run(({ idempotency }) => idempotency.find('k2'))).toBeNull();
  });

  it('throws DuplicateKeyError when the key already exists', async () => {
    await h.uow.run(async ({ charges, idempotency }) => {
      await charges.insert(makeCharge('ch_a'));
      await idempotency.save(record('k1', 'ch_a'));
    });
    const again = h.uow.run(({ idempotency }) => idempotency.save(record('k1', 'ch_a')));
    await expect(again).rejects.toBeInstanceOf(DuplicateKeyError);
  });
});

describe('KyselyWebhookOutbox', () => {
  async function seedEvent(): Promise<WebhookEvent> {
    const done = makeCharge('ch_a').complete(t0);
    const event = WebhookEvent.forCharge(done, 'evt_1', t0);
    await h.uow.run(async ({ charges, webhooks }) => {
      await charges.insert(makeCharge('ch_a'));
      await charges.save(done);
      await webhooks.add(event);
    });
    return event;
  }

  it('round-trips an event through lockDue()', async () => {
    const event = await seedEvent();
    const due = await h.uow.run(({ webhooks }) => webhooks.lockDue(t0, 10));
    expect(due.map((e) => e.toProps())).toEqual([event.toProps()]);
  });

  it('lockDue() ignores events whose time has not come, and non-PENDING events', async () => {
    const event = await seedEvent();
    expect(await h.uow.run(({ webhooks }) => webhooks.lockDue(new Date(t0.getTime() - 1), 10))).toEqual([]);
    await h.uow.run(({ webhooks }) => webhooks.save(event.recordSuccess(plus(1))));
    expect(await h.uow.run(({ webhooks }) => webhooks.lockDue(plus(100), 10))).toEqual([]);
  });

  it('save() persists the lifecycle and recordAttempt() keeps a truncated error', async () => {
    const event = await seedEvent();
    const failed = event.recordFailure(plus(1), [5]);
    await h.uow.run(async ({ webhooks }) => {
      await webhooks.save(failed);
      await webhooks.recordAttempt({
        eventId: 'evt_1',
        attemptNo: 1,
        attemptedAt: plus(1),
        statusCode: 500,
        error: 'x'.repeat(600),
      });
    });
    const rows = await h.db.selectFrom('webhook_events').selectAll().execute();
    expect(rows[0]).toMatchObject({ status: 'PENDING', attempts: 1, next_attempt_at: plus(6) });
    const attempts = await h.db.selectFrom('webhook_attempts').selectAll().execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status_code).toBe(500);
    expect(attempts[0]?.error_message).toHaveLength(500);
  });
});
```

- [ ] **Step 8: Cài mapper, repository, unit of work và harness**

`services/payment/src/infrastructure/kysely/mappers.ts`:
```ts
import { dateTime, toSafeInteger } from '@billing/database';
import { Money, type Currency } from '@billing/money';
import type { Insertable, Selectable } from 'kysely';
import { Charge } from '../../domain/charge.js';
import type { ChargeStatus } from '../../domain/charge.js';
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
    next_attempt_at: p.nextAttemptAt === null ? null : (dateTime(p.nextAttemptAt) as unknown as Date),
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

`services/payment/src/infrastructure/kysely/charge.repository.ts`:
```ts
import { dateTime, toSafeInteger } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  ChargeRepository,
  CompletedCursor,
  SettlementTotal,
} from '../../application/ports.js';
import type { Charge } from '../../domain/charge.js';
import { chargeToRow, rowToCharge } from './mappers.js';
import type { ChargesTable, PaymentDatabase } from './schema.js';

export class KyselyChargeRepository implements ChargeRepository {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async insert(charge: Charge): Promise<void> {
    await this.db.insertInto('charges').values(chargeToRow(charge)).execute();
  }

  async findById(id: string): Promise<Charge | null> {
    const row = await this.db.selectFrom('charges').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? rowToCharge(row) : null;
  }

  async lockDue(now: Date, limit: number): Promise<Charge[]> {
    // Cần index ix_charges_due (status, due_at, id): không có nó READPAST không bỏ qua được hàng nào có ích.
    const result = await sql<Selectable<ChargesTable>>`
      select top (${limit}) id, reference, amount, currency, status, failure_code, scenario,
             due_at, created_at, completed_at
      from charges with (updlock, readpast, rowlock)
      where status = ${'PENDING'} and due_at <= ${dateTime(now)}
      order by due_at, id`.execute(this.db);
    return result.rows.map(rowToCharge);
  }

  async save(charge: Charge): Promise<void> {
    const row = chargeToRow(charge);
    await this.db
      .updateTable('charges')
      .set({
        status: row.status,
        failure_code: row.failure_code ?? null,
        completed_at: row.completed_at ?? null,
      })
      .where('id', '=', row.id)
      .execute();
  }

  async listCompleted(query: {
    from: Date;
    to: Date;
    limit: number;
    after: CompletedCursor | null;
  }): Promise<Charge[]> {
    let builder = this.db
      .selectFrom('charges')
      .selectAll()
      .where('completed_at', '>=', dateTime(query.from))
      .where('completed_at', '<', dateTime(query.to));
    if (query.after) {
      const at = dateTime(query.after.completedAt);
      const afterId = query.after.id;
      builder = builder.where((eb) =>
        eb.or([
          eb('completed_at', '>', at),
          eb.and([eb('completed_at', '=', at), eb('id', '>', afterId)]),
        ]),
      );
    }
    const rows = await builder.orderBy('completed_at').orderBy('id').top(query.limit).execute();
    return rows.map(rowToCharge);
  }

  async totals(range: { from: Date; to: Date }): Promise<SettlementTotal[]> {
    const rows = await this.db
      .selectFrom('charges')
      .select([
        'currency',
        'status',
        (eb) => eb.fn.countAll().as('count'),
        (eb) => eb.fn.sum('amount').as('total'),
      ])
      .where('completed_at', '>=', dateTime(range.from))
      .where('completed_at', '<', dateTime(range.to))
      .groupBy(['currency', 'status'])
      .orderBy('currency')
      .orderBy('status')
      .execute();
    return rows.map((row) => ({
      currency: row.currency,
      status: row.status as SettlementTotal['status'],
      count: toSafeInteger(row.count),
      totalAmount: toSafeInteger(row.total),
    }));
  }
}
```

`services/payment/src/infrastructure/kysely/idempotency.repository.ts`:
```ts
import { dateTime, isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { IdempotencyStore, StoredResponse } from '../../application/ports.js';
import type { PaymentDatabase } from './schema.js';

export class KyselyIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async find(key: string): Promise<StoredResponse | null> {
    const row = await this.db
      .selectFrom('idempotency_keys')
      .selectAll()
      .where('idempotency_key', '=', key)
      .executeTakeFirst();
    if (!row) return null;
    return {
      key: row.idempotency_key,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      chargeId: row.charge_id,
      createdAt: row.created_at,
    };
  }

  async save(record: StoredResponse): Promise<void> {
    try {
      await this.db
        .insertInto('idempotency_keys')
        .values({
          idempotency_key: record.key,
          request_hash: record.requestHash,
          response_status: record.responseStatus,
          response_body: record.responseBody,
          charge_id: record.chargeId,
          created_at: dateTime(record.createdAt) as unknown as Date,
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

`services/payment/src/infrastructure/kysely/webhook.repository.ts`:
```ts
import { dateTime } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { WebhookAttemptRecord, WebhookOutbox } from '../../application/ports.js';
import type { WebhookEvent } from '../../domain/webhook-event.js';
import { rowToWebhook, webhookToRow } from './mappers.js';
import type { PaymentDatabase, WebhookEventsTable } from './schema.js';

const MAX_ERROR_LENGTH = 500;

export class KyselyWebhookOutbox implements WebhookOutbox {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async add(event: WebhookEvent): Promise<void> {
    await this.db.insertInto('webhook_events').values(webhookToRow(event)).execute();
  }

  async lockDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    // Cần index ix_webhook_due (status, next_attempt_at, event_id) để READPAST hoạt động đúng.
    const result = await sql<Selectable<WebhookEventsTable>>`
      select top (${limit}) event_id, charge_id, event_type, payload, status, attempts,
             next_attempt_at, send_twice, created_at, delivered_at
      from webhook_events with (updlock, readpast, rowlock)
      where status = ${'PENDING'} and next_attempt_at <= ${dateTime(now)}
      order by next_attempt_at, event_id`.execute(this.db);
    return result.rows.map(rowToWebhook);
  }

  async save(event: WebhookEvent): Promise<void> {
    const row = webhookToRow(event);
    await this.db
      .updateTable('webhook_events')
      .set({
        status: row.status,
        attempts: row.attempts,
        next_attempt_at: row.next_attempt_at ?? null,
        delivered_at: row.delivered_at ?? null,
      })
      .where('event_id', '=', row.event_id)
      .execute();
  }

  async recordAttempt(attempt: WebhookAttemptRecord): Promise<void> {
    await this.db
      .insertInto('webhook_attempts')
      .values({
        event_id: attempt.eventId,
        attempt_no: attempt.attemptNo,
        attempted_at: dateTime(attempt.attemptedAt) as unknown as Date,
        status_code: attempt.statusCode,
        error_message: attempt.error === null ? null : attempt.error.slice(0, MAX_ERROR_LENGTH),
      })
      .execute();
  }
}
```

`services/payment/src/infrastructure/kysely/unit-of-work.ts`:
```ts
import type { Kysely } from 'kysely';
import type { Repositories, UnitOfWork } from '../../application/ports.js';
import { KyselyChargeRepository } from './charge.repository.js';
import { KyselyIdempotencyStore } from './idempotency.repository.js';
import type { PaymentDatabase } from './schema.js';
import { KyselyWebhookOutbox } from './webhook.repository.js';

/** Mỗi `run` là một transaction SQL; các repository đều gắn với transaction đó. */
export class KyselyUnitOfWork implements UnitOfWork {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) =>
      work({
        charges: new KyselyChargeRepository(trx),
        idempotency: new KyselyIdempotencyStore(trx),
        webhooks: new KyselyWebhookOutbox(trx),
      }),
    );
  }
}
```

`services/payment/src/test-support.ts`:
```ts
import { createDatabase, migrate } from '@billing/database';
import { FakeClock, createTestDatabase } from '@billing/testing';
import type { Kysely } from 'kysely';
import { paymentMigrations } from '../../../db/payment/migrations.js';
import type { IdGenerator } from './application/ports.js';
import type { PaymentDatabase } from './infrastructure/kysely/schema.js';
import { KyselyUnitOfWork } from './infrastructure/kysely/unit-of-work.js';

/** Mã định danh tất định để test so sánh được: ch_000001, evt_000001, ... */
export class SequentialIds implements IdGenerator {
  #charges = 0;
  #events = 0;

  chargeId(): string {
    return `ch_${String(++this.#charges).padStart(6, '0')}`;
  }

  eventId(): string {
    return `evt_${String(++this.#events).padStart(6, '0')}`;
  }
}

export interface Harness {
  db: Kysely<PaymentDatabase>;
  clock: FakeClock;
  ids: SequentialIds;
  uow: KyselyUnitOfWork;
  close(): Promise<void>;
}

/** Dựng một database riêng đã migrate, kèm clock giả và id tất định. Chỉ dùng trong integration test. */
export async function createHarness(start = '2026-10-09T10:00:00.000Z'): Promise<Harness> {
  const testDb = await createTestDatabase('payment');
  const db = createDatabase<PaymentDatabase>(testDb.config);
  await migrate(db, paymentMigrations);
  return {
    db,
    clock: new FakeClock(start),
    ids: new SequentialIds(),
    uow: new KyselyUnitOfWork(db),
    async close() {
      await db.destroy();
      await testDb.drop();
    },
  };
}

/** Xóa sạch dữ liệu theo đúng thứ tự khóa ngoại. */
export async function resetTables(db: Kysely<PaymentDatabase>): Promise<void> {
  await db.deleteFrom('webhook_attempts').execute();
  await db.deleteFrom('webhook_events').execute();
  await db.deleteFrom('idempotency_keys').execute();
  await db.deleteFrom('charges').execute();
}
```

- [ ] **Step 9: Chạy integration test, lint, typecheck**

Run: `corepack pnpm test:integration services/payment && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS, gồm ca `READPAST`: transaction thứ hai nhận `ch_b` khi transaction đầu đang giữ `ch_a`. Nếu `typecheck` phàn nàn ở `chargeToRow`/`save` về `RawBuilder` so với `Date`, giữ nguyên các ép kiểu `as unknown as Date` (Kysely chấp nhận biểu thức ở runtime; kiểu cột chỉ khai báo `Date`).

- [ ] **Step 10: Commit**

```bash
git add db services/payment packages package.json pnpm-lock.yaml
git commit -m "feat(payment): add migration, ports and Kysely repositories with READPAST locking"
```

---

### Task 7: Use case `CreateCharge` (idempotency)

**Files:**
- Create: `services/payment/src/application/views.ts`, `application/create-charge.ts`
- Test: `services/payment/src/application/create-charge.integration.test.ts`

**Interfaces:**
- Consumes: `UnitOfWork`, `Clock`, `IdGenerator`, `DuplicateKeyError`, `IdempotencyConflictError` (Task 6); `Charge`, `parseScenario` (Task 4/5).
- Produces:
  - `interface ChargeCreatedView { chargeId: string; reference: string; amount: number; currency: string; status: 'PENDING'; createdAt: string }`
  - `interface ChargeView { chargeId: string; reference: string; amount: number; currency: string; status: ChargeStatus; failureCode?: string; createdAt: string; completedAt?: string }`
  - `toCreatedView(charge: Charge): ChargeCreatedView`, `toChargeView(charge: Charge): ChargeView`
  - `interface CreateChargeInput { idempotencyKey: string; amount: number; currency: string; reference: string; simulate?: string | undefined }`
  - `interface CreateChargeResult { status: number; body: ChargeCreatedView; replayed: boolean; responseTimeout: boolean }`
  - `class CreateCharge { constructor(deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator }); execute(input: CreateChargeInput): Promise<CreateChargeResult> }` — ném `InvalidScenarioError`, `InvalidMoneyError` (số tiền không nguyên / tiền tệ lạ), `InvalidChargeError`, `IdempotencyConflictError`; `responseTimeout` chỉ `true` ở lần tạo đầu tiên (không ở replay)

- [ ] **Step 1: Viết test thất bại**

`services/payment/src/application/create-charge.integration.test.ts`:
```ts
import { InvalidMoneyError } from '@billing/money';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidChargeError } from '../domain/errors.js';
import { InvalidScenarioError } from '../domain/scenario.js';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { IdempotencyConflictError } from './errors.js';
import { CreateCharge, type CreateChargeInput } from './create-charge.js';

let h: Harness;
let createCharge: CreateCharge;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
});

const input = (overrides: Partial<CreateChargeInput> = {}): CreateChargeInput => ({
  idempotencyKey: 'key-1',
  amount: 150000,
  currency: 'VND',
  reference: 'topup-1',
  ...overrides,
});

const chargeRows = () => h.db.selectFrom('charges').selectAll().execute();

describe('CreateCharge', () => {
  it('creates a PENDING charge due immediately and answers 202', async () => {
    const result = await createCharge.execute(input());
    expect(result).toMatchObject({
      status: 202,
      replayed: false,
      responseTimeout: false,
      body: {
        reference: 'topup-1',
        amount: 150000,
        currency: 'VND',
        status: 'PENDING',
        createdAt: '2026-10-09T10:00:00.000Z',
      },
    });
    const rows = await chargeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: result.body.chargeId, status: 'PENDING', due_at: h.clock.now() });
  });

  it('schedules the charge after the delay in X-Simulate', async () => {
    await createCharge.execute(input({ simulate: 'delay=5' }));
    const [row] = await chargeRows();
    expect(row?.due_at).toEqual(new Date('2026-10-09T10:00:05.000Z'));
  });

  it('flags responseTimeout on the first call only', async () => {
    const first = await createCharge.execute(input({ simulate: 'response=timeout' }));
    const replay = await createCharge.execute(input({ simulate: 'response=timeout' }));
    expect(first).toMatchObject({ replayed: false, responseTimeout: true });
    expect(replay).toMatchObject({ replayed: true, responseTimeout: false });
    expect(replay.body).toEqual(first.body);
  });

  it('replays the stored 202 for the same key and the same content', async () => {
    const first = await createCharge.execute(input());
    h.clock.advanceSeconds(30);
    const replay = await createCharge.execute(input());
    expect(replay).toMatchObject({ status: 202, replayed: true });
    expect(replay.body).toEqual(first.body);
    expect(await chargeRows()).toHaveLength(1);
  });

  it('treats reordered X-Simulate tokens as the same content', async () => {
    const first = await createCharge.execute(input({ simulate: 'fail=a_b,delay=2' }));
    const replay = await createCharge.execute(input({ simulate: 'delay=2, fail=a_b' }));
    expect(replay).toMatchObject({ replayed: true });
    expect(replay.body.chargeId).toBe(first.body.chargeId);
  });

  it.each([
    ['amount', { amount: 150001 }],
    ['currency', { currency: 'USD' }],
    ['reference', { reference: 'topup-2' }],
    ['X-Simulate', { simulate: 'fail=card_declined' }],
  ])('rejects the same key with a different %s', async (_name, change) => {
    await createCharge.execute(input());
    await expect(createCharge.execute(input(change))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await chargeRows()).toHaveLength(1);
  });

  it('creates exactly one charge when the same key is submitted concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => createCharge.execute(input())));
    expect(new Set(results.map((r) => r.body.chargeId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await chargeRows()).toHaveLength(1);
  });

  it('keeps different keys independent', async () => {
    await createCharge.execute(input({ idempotencyKey: 'a' }));
    await createCharge.execute(input({ idempotencyKey: 'b' }));
    expect(await chargeRows()).toHaveLength(2);
  });

  it.each([
    ['a fractional amount', { amount: 10.5 }, InvalidMoneyError],
    ['an unsupported currency', { currency: 'EUR' }, InvalidMoneyError],
    ['a zero amount', { amount: 0 }, InvalidChargeError],
    ['a negative amount', { amount: -5 }, InvalidChargeError],
    ['an empty reference', { reference: '  ' }, InvalidChargeError],
    ['an unknown X-Simulate token', { simulate: 'explode=1' }, InvalidScenarioError],
  ])('rejects %s and persists nothing', async (_name, change, errorType) => {
    await expect(createCharge.execute(input(change))).rejects.toBeInstanceOf(errorType);
    expect(await chargeRows()).toHaveLength(0);
    expect(await h.db.selectFrom('idempotency_keys').selectAll().execute()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration create-charge`
Expected: FAIL (không resolve được `./create-charge.js`).

- [ ] **Step 3: Cài code**

`services/payment/src/application/views.ts`:
```ts
import type { Charge, ChargeStatus } from '../domain/charge.js';

export interface ChargeCreatedView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: 'PENDING';
  createdAt: string;
}

export interface ChargeView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: ChargeStatus;
  failureCode?: string;
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
    createdAt: p.createdAt.toISOString(),
    ...(p.completedAt === null ? {} : { completedAt: p.completedAt.toISOString() }),
  };
}
```

`services/payment/src/application/create-charge.ts`:
```ts
import { createHash } from 'node:crypto';
import { Money, type Currency } from '@billing/money';
import { Charge } from '../domain/charge.js';
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
    // Băm nội dung đã chuẩn hóa: thứ tự token trong X-Simulate không làm đổi hash.
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          amount: amount.amount,
          currency: amount.currency,
          reference: input.reference,
          scenario,
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

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm test:integration create-charge && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS, gồm ca đồng thời (5 request cùng key chỉ tạo đúng 1 charge).

- [ ] **Step 5: Commit**

```bash
git add services/payment
git commit -m "feat(payment): add CreateCharge use case with idempotency"
```

### Task 8: Use case `CompleteDueCharges`

**Files:**
- Create: `services/payment/src/application/complete-due-charges.ts`
- Test: `services/payment/src/application/complete-due-charges.integration.test.ts`

**Interfaces:**
- Consumes: `UnitOfWork`, `Clock`, `IdGenerator` (Task 6); `Charge.complete`, `WebhookEvent.forCharge` (Task 5); `CreateCharge` (Task 7, chỉ trong test).
- Produces: `class CompleteDueCharges { constructor(deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator }); execute(limit?: number): Promise<number> }` — hoàn tất tối đa `limit` (mặc định 50) charge đã đến hạn trong **một** transaction, ghi `webhook_events` cùng transaction (trừ khi `webhook=drop`), trả về số charge đã hoàn tất.

- [ ] **Step 1: Viết test thất bại**

`services/payment/src/application/complete-due-charges.integration.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set('2026-10-09T10:00:00.000Z');
});

const create = (key: string, simulate?: string) =>
  createCharge.execute({
    idempotencyKey: key,
    amount: 1000,
    currency: 'VND',
    reference: `ref-${key}`,
    simulate,
  });
const charges = () =>
  h.db.selectFrom('charges').select(['id', 'status', 'failure_code', 'completed_at']).orderBy('id').execute();
const events = () => h.db.selectFrom('webhook_events').selectAll().orderBy('event_id').execute();

describe('CompleteDueCharges', () => {
  it('completes only the charges that are due, and queues one webhook event for each', async () => {
    const ok = await create('a');
    const delayed = await create('b', 'delay=10');
    const failing = await create('c', 'fail=card_declined');

    expect(await completeDue.execute()).toBe(2);

    const byId = new Map((await charges()).map((c) => [c.id, c]));
    expect(byId.get(ok.body.chargeId)).toMatchObject({ status: 'SUCCEEDED', failure_code: null });
    expect(byId.get(failing.body.chargeId)).toMatchObject({
      status: 'FAILED',
      failure_code: 'card_declined',
    });
    expect(byId.get(delayed.body.chargeId)).toMatchObject({ status: 'PENDING', completed_at: null });

    const queued = await events();
    expect(queued.map((e) => [e.charge_id, e.event_type, e.status, e.attempts])).toEqual([
      [ok.body.chargeId, 'charge.succeeded', 'PENDING', 0],
      [failing.body.chargeId, 'charge.failed', 'PENDING', 0],
    ]);
    expect(queued[0]?.next_attempt_at).toEqual(h.clock.now());

    h.clock.advanceSeconds(10);
    expect(await completeDue.execute()).toBe(1);
    expect((await charges()).every((c) => c.status !== 'PENDING')).toBe(true);
    expect(await events()).toHaveLength(3);
  });

  it('stamps completed_at with the clock, keeping milliseconds', async () => {
    h.clock.set('2026-10-09T10:00:00.123Z');
    await create('a');
    await completeDue.execute();
    const [row] = await charges();
    expect(row?.completed_at).toEqual(new Date('2026-10-09T10:00:00.123Z'));
  });

  it('is idempotent: running again completes nothing and queues nothing', async () => {
    await create('a');
    expect(await completeDue.execute()).toBe(1);
    expect(await completeDue.execute()).toBe(0);
    expect(await events()).toHaveLength(1);
  });

  it('queues no event for webhook=drop, and flags send_twice for webhook=duplicate', async () => {
    const dropped = await create('a', 'webhook=drop');
    const doubled = await create('b', 'webhook=duplicate');
    expect(await completeDue.execute()).toBe(2);

    const queued = await events();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ charge_id: doubled.body.chargeId, send_twice: true });
    const droppedRow = (await charges()).find((c) => c.id === dropped.body.chargeId);
    expect(droppedRow?.status).toBe('SUCCEEDED');
  });

  it('honours the limit', async () => {
    for (const key of ['a', 'b', 'c']) await create(key);
    expect(await completeDue.execute(2)).toBe(2);
    expect(await completeDue.execute(2)).toBe(1);
  });

  it('lets two concurrent workers split the work without completing anything twice', async () => {
    for (const key of ['a', 'b', 'c', 'd']) await create(key);
    const [first, second] = await Promise.all([completeDue.execute(2), completeDue.execute(2)]);
    expect(first + second).toBe(4);
    expect((await charges()).every((c) => c.status === 'SUCCEEDED')).toBe(true);
    const queued = await events();
    expect(new Set(queued.map((e) => e.charge_id)).size).toBe(4);
    expect(queued).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration complete-due-charges`
Expected: FAIL (không resolve được `./complete-due-charges.js`).

- [ ] **Step 3: Cài code**

`services/payment/src/application/complete-due-charges.ts`:
```ts
import { WebhookEvent } from '../domain/webhook-event.js';
import type { Clock, IdGenerator, UnitOfWork } from './ports.js';

const DEFAULT_BATCH = 50;

export class CompleteDueCharges {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock; ids: IdGenerator }) {}

  /** Hoàn tất charge đến hạn và ghi sự kiện webhook trong cùng một transaction. */
  async execute(limit = DEFAULT_BATCH): Promise<number> {
    return this.deps.uow.run(async ({ charges, webhooks }) => {
      const now = this.deps.clock.now();
      const due = await charges.lockDue(now, limit);
      for (const charge of due) {
        const completed = charge.complete(now);
        await charges.save(completed);
        if (completed.toProps().scenario.webhook !== 'drop') {
          await webhooks.add(WebhookEvent.forCharge(completed, this.deps.ids.eventId(), now));
        }
      }
      return due.length;
    });
  }
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm test:integration complete-due-charges && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS, gồm ca hai worker đồng thời (nhờ index `ix_charges_due` + `READPAST`).

- [ ] **Step 5: Commit**

```bash
git add services/payment
git commit -m "feat(payment): add CompleteDueCharges worker use case"
```

---

### Task 9: Gửi webhook (`HttpWebhookSender`) và use case `DeliverDueWebhooks`

**Files:**
- Create: `services/payment/src/infrastructure/http-webhook-sender.ts`, `services/payment/src/application/deliver-due-webhooks.ts`
- Modify: `services/payment/src/test-support.ts` (thêm `createWebhookSender`)
- Test: `services/payment/src/infrastructure/http-webhook-sender.test.ts` (unit, không cần Docker), `services/payment/src/application/deliver-due-webhooks.integration.test.ts`

**Interfaces:**
- Consumes: `WebhookSender`, `WebhookSendResult`, `UnitOfWork`, `Clock` (Task 6); `WebhookEvent` (Task 5); `signWebhook` (Task 3); `WebhookReceiver` (Task 2).
- Produces:
  - `interface HttpWebhookSenderOptions { url: string; secret: string; timeoutMs?: number; fetchImpl?: typeof fetch }` (`timeoutMs` mặc định 10 000)
  - `class HttpWebhookSender implements WebhookSender` — `POST` `payload` thô với header `content-type: application/json`, `x-signature` (ký bằng `now`), `x-webhook-event-id`; `redirect: 'manual'`; `2xx` ⇒ `{ ok: true, statusCode }`; mã khác ⇒ `{ ok: false, statusCode, error: 'HTTP <code>' }`; lỗi mạng/timeout ⇒ `{ ok: false, error }`; không bao giờ ném
  - `interface DeliveryReport { delivered: number; retrying: number; failed: number }`
  - `class DeliverDueWebhooks { constructor(deps: { uow: UnitOfWork; sender: WebhookSender; clock: Clock; backoffSeconds: readonly number[]; leaseSeconds?: number }); execute(limit?: number): Promise<DeliveryReport> }` (`leaseSeconds` mặc định 60, `limit` mặc định 50)
  - `createWebhookSender(url: string, secret: string): HttpWebhookSender` trong `test-support.ts`

- [ ] **Step 1: Viết test thất bại cho sender (unit)**

`services/payment/src/infrastructure/http-webhook-sender.test.ts`:
```ts
import { validateChargeWebhook, verifyWebhook } from '@billing/contracts';
import { Money } from '@billing/money';
import { WebhookReceiver } from '@billing/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Charge } from '../domain/charge.js';
import { DEFAULT_SCENARIO } from '../domain/scenario.js';
import { WebhookEvent } from '../domain/webhook-event.js';
import { HttpWebhookSender } from './http-webhook-sender.js';

const secret = 'test-secret';
const now = new Date('2026-10-09T10:00:00.000Z');
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

const makeEvent = () =>
  WebhookEvent.forCharge(
    Charge.create({
      id: 'ch_1',
      reference: 'topup-1',
      amount: Money.of(150000, 'VND'),
      scenario: DEFAULT_SCENARIO,
      now,
    }).complete(now),
    'evt_1',
    now,
  );

let receiver: WebhookReceiver;
beforeEach(async () => {
  receiver = await WebhookReceiver.start();
});
afterEach(async () => {
  await receiver.close();
});

const sender = (overrides: Partial<ConstructorParameters<typeof HttpWebhookSender>[0]> = {}) =>
  new HttpWebhookSender({ url: receiver.url, secret, timeoutMs: 1000, ...overrides });

describe('HttpWebhookSender', () => {
  it('posts the raw payload with a verifiable signature and the event id', async () => {
    const event = makeEvent();
    expect(await sender().send(event, now)).toEqual({ ok: true, statusCode: 200 });

    const [request] = receiver.received;
    expect(request?.body).toBe(event.toProps().payload);
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.headers['x-webhook-event-id']).toBe('evt_1');
    expect(
      verifyWebhook({
        secret,
        body: request?.body ?? '',
        header: request?.headers['x-signature'] as string,
        nowSeconds: seconds(now),
      }),
    ).toEqual({ ok: true });
    expect(validateChargeWebhook(JSON.parse(request?.body ?? '')).ok).toBe(true);
  });

  it('signs with the timestamp it is given, so every retry carries a fresh signature', async () => {
    const later = new Date(now.getTime() + 60_000);
    await sender().send(makeEvent(), later);
    const header = receiver.received[0]?.headers['x-signature'] as string;
    expect(header.startsWith(`t=${seconds(later)},`)).toBe(true);
  });

  it('reports a non-2xx answer as a failure with its status code', async () => {
    receiver.respondWith(500);
    expect(await sender().send(makeEvent(), now)).toEqual({
      ok: false,
      statusCode: 500,
      error: 'HTTP 500',
    });
  });

  it('does not follow redirects', async () => {
    receiver.respondWith(302);
    expect(await sender().send(makeEvent(), now)).toMatchObject({ ok: false, statusCode: 302 });
    expect(receiver.received).toHaveLength(1);
  });

  it('reports a connection error without throwing', async () => {
    await receiver.close();
    const result = await sender().send(makeEvent(), now);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBeUndefined();
    expect(result.error).toBeTruthy();
  });

  it('gives up on a receiver that is too slow', async () => {
    receiver.setDelay(500);
    const result = await sender({ timeoutMs: 50 }).send(makeEvent(), now);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/abort|timeout/i);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/payment/src/infrastructure/http-webhook-sender.test.ts`
Expected: FAIL (không resolve được `./http-webhook-sender.js`).

- [ ] **Step 3: Cài sender**

`services/payment/src/infrastructure/http-webhook-sender.ts`:
```ts
import { signWebhook } from '@billing/contracts';
import type { WebhookSender, WebhookSendResult } from '../application/ports.js';
import type { WebhookEvent } from '../domain/webhook-event.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HttpWebhookSenderOptions {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpWebhookSender implements WebhookSender {
  constructor(private readonly options: HttpWebhookSenderOptions) {}

  async send(event: WebhookEvent, now: Date): Promise<WebhookSendResult> {
    const { eventId, payload } = event.toProps();
    const timestamp = Math.floor(now.getTime() / 1000);
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(this.options.url, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          'x-signature': signWebhook(this.options.secret, payload, timestamp),
          'x-webhook-event-id': eventId,
        },
        body: payload,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return { ok: true, statusCode: response.status };
      return { ok: false, statusCode: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
```

- [ ] **Step 4: Chạy lại test sender**

Run: `corepack pnpm exec vitest run services/payment/src/infrastructure/http-webhook-sender.test.ts`
Expected: PASS (6 test).

- [ ] **Step 5: Thêm `createWebhookSender` vào `test-support.ts`**

Sửa `services/payment/src/test-support.ts`: thêm dòng import ngay trên dòng `import { KyselyUnitOfWork } from './infrastructure/kysely/unit-of-work.js';`:
```ts
import { HttpWebhookSender } from './infrastructure/http-webhook-sender.js';
```
và thêm hàm này ngay trên comment `/** Xóa sạch dữ liệu theo đúng thứ tự khóa ngoại. */`:
```ts
/** Test trong thư mục application/ không được import infrastructure trực tiếp nên đi qua đây. */
export function createWebhookSender(url: string, secret: string): HttpWebhookSender {
  return new HttpWebhookSender({ url, secret, timeoutMs: 2000 });
}

```

- [ ] **Step 6: Viết integration test thất bại cho `DeliverDueWebhooks`**

`services/payment/src/application/deliver-due-webhooks.integration.test.ts`:
```ts
import { verifyWebhook } from '@billing/contracts';
import { WebhookReceiver } from '@billing/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, createWebhookSender, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { DeliverDueWebhooks } from './deliver-due-webhooks.js';

const secret = 'test-secret';
const T0 = '2026-10-09T10:00:00.000Z';

let h: Harness;
let receiver: WebhookReceiver;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let deliver: DeliverDueWebhooks;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set(T0);
  receiver = await WebhookReceiver.start();
  deliver = new DeliverDueWebhooks({
    uow: h.uow,
    sender: createWebhookSender(receiver.url, secret),
    clock: h.clock,
    backoffSeconds: [1, 5],
    leaseSeconds: 60,
  });
});
afterEach(async () => {
  await receiver.close();
});

/** Tạo charge rồi hoàn tất nó, để lại một webhook_event PENDING đến hạn ngay. */
async function seed(key: string, simulate?: string): Promise<void> {
  await createCharge.execute({
    idempotencyKey: key,
    amount: 1000,
    currency: 'VND',
    reference: `ref-${key}`,
    simulate,
  });
  await completeDue.execute();
}
const events = () => h.db.selectFrom('webhook_events').selectAll().orderBy('event_id').execute();
const attempts = () =>
  h.db.selectFrom('webhook_attempts').selectAll().orderBy('event_id').orderBy('attempt_no').execute();
const plus = (seconds: number) => new Date(new Date(T0).getTime() + seconds * 1000);

describe('DeliverDueWebhooks', () => {
  it('does nothing when no event is due', async () => {
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    expect(receiver.received).toHaveLength(0);
  });

  it('delivers a due event with a valid signature and records the attempt', async () => {
    await seed('a');
    expect(await deliver.execute()).toEqual({ delivered: 1, retrying: 0, failed: 0 });

    const [request] = receiver.received;
    expect(
      verifyWebhook({
        secret,
        body: request?.body ?? '',
        header: request?.headers['x-signature'] as string,
        nowSeconds: Math.floor(h.clock.now().getTime() / 1000),
      }),
    ).toEqual({ ok: true });

    const [event] = await events();
    expect(event).toMatchObject({ status: 'DELIVERED', attempts: 1, next_attempt_at: null });
    expect(event?.delivered_at).toEqual(h.clock.now());
    expect(await attempts()).toMatchObject([{ attempt_no: 1, status_code: 200, error_message: null }]);
  });

  it('retries on the backoff schedule, then gives up and keeps the event as FAILED', async () => {
    receiver.setDefaultStatus(500);
    await seed('a');

    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    let [event] = await events();
    expect(event).toMatchObject({ status: 'PENDING', attempts: 1, next_attempt_at: plus(1) });

    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    expect(receiver.received).toHaveLength(1);

    h.clock.advanceSeconds(1);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    [event] = await events();
    expect(event).toMatchObject({ status: 'PENDING', attempts: 2, next_attempt_at: plus(6) });

    h.clock.advanceSeconds(5);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 1 });
    [event] = await events();
    expect(event).toMatchObject({ status: 'FAILED', attempts: 3, next_attempt_at: null });
    expect(receiver.received).toHaveLength(3);
    expect(await attempts()).toMatchObject([
      { attempt_no: 1, status_code: 500, error_message: 'HTTP 500' },
      { attempt_no: 2, status_code: 500, error_message: 'HTTP 500' },
      { attempt_no: 3, status_code: 500, error_message: 'HTTP 500' },
    ]);

    h.clock.advanceSeconds(10_000);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    expect(receiver.received).toHaveLength(3);
  });

  it('delivers on a later attempt once the receiver recovers', async () => {
    receiver.respondWith(500);
    await seed('a');
    expect(await deliver.execute()).toMatchObject({ retrying: 1 });
    h.clock.advanceSeconds(1);
    expect(await deliver.execute()).toMatchObject({ delivered: 1 });
    const [event] = await events();
    expect(event).toMatchObject({ status: 'DELIVERED', attempts: 2 });
  });

  it('sends the same event twice for webhook=duplicate but counts one attempt', async () => {
    await seed('a', 'webhook=duplicate');
    expect(await deliver.execute()).toMatchObject({ delivered: 1 });
    expect(receiver.received).toHaveLength(2);
    expect(receiver.received[0]?.body).toBe(receiver.received[1]?.body);
    expect(receiver.received[0]?.headers['x-webhook-event-id']).toBe(
      receiver.received[1]?.headers['x-webhook-event-id'],
    );
    expect(await attempts()).toHaveLength(1);
  });

  it('records a connection failure and schedules a retry', async () => {
    await seed('a');
    await receiver.close();
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 1, failed: 0 });
    const [attempt] = await attempts();
    expect(attempt?.status_code).toBeNull();
    expect(attempt?.error_message).toBeTruthy();
  });

  it('does not redeliver an event that is leased until the lease expires (crash recovery)', async () => {
    await seed('a');
    await h.uow.run(async ({ webhooks }) => {
      const [claimed] = await webhooks.lockDue(h.clock.now(), 10);
      if (!claimed) throw new Error('expected a due event');
      await webhooks.save(claimed.claim(h.clock.now(), 60));
    });

    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    h.clock.advanceSeconds(59);
    expect(await deliver.execute()).toEqual({ delivered: 0, retrying: 0, failed: 0 });
    h.clock.advanceSeconds(1);
    expect(await deliver.execute()).toMatchObject({ delivered: 1 });
  });

  it('honours the limit', async () => {
    for (const key of ['a', 'b', 'c']) await seed(key);
    expect(await deliver.execute(2)).toMatchObject({ delivered: 2 });
    expect(await deliver.execute(2)).toMatchObject({ delivered: 1 });
  });
});
```

- [ ] **Step 7: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration deliver-due-webhooks`
Expected: FAIL (không resolve được `./deliver-due-webhooks.js`).

- [ ] **Step 8: Cài use case**

`services/payment/src/application/deliver-due-webhooks.ts`:
```ts
import type { Clock, UnitOfWork, WebhookSender } from './ports.js';

const DEFAULT_BATCH = 50;
const DEFAULT_LEASE_SECONDS = 60;

export interface DeliveryReport {
  delivered: number;
  retrying: number;
  failed: number;
}

export class DeliverDueWebhooks {
  private readonly leaseSeconds: number;

  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      sender: WebhookSender;
      clock: Clock;
      backoffSeconds: readonly number[];
      leaseSeconds?: number;
    },
  ) {
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  /**
   * 1) Trong một transaction: chọn sự kiện đến hạn rồi "chiếm" chúng bằng cách đẩy `next_attempt_at`
   *    thêm một lease. 2) Gửi HTTP NGOÀI transaction (không giữ khóa DB trong lúc chờ mạng).
   * 3) Ghi kết quả. Nếu tiến trình chết giữa chừng, sự kiện tự đến hạn lại khi lease hết.
   */
  async execute(limit = DEFAULT_BATCH): Promise<DeliveryReport> {
    const claimed = await this.deps.uow.run(async ({ webhooks }) => {
      const now = this.deps.clock.now();
      const due = await webhooks.lockDue(now, limit);
      for (const event of due) await webhooks.save(event.claim(now, this.leaseSeconds));
      return due;
    });

    const report: DeliveryReport = { delivered: 0, retrying: 0, failed: 0 };
    for (const event of claimed) {
      const result = await this.deps.sender.send(event, this.deps.clock.now());

      const status = await this.deps.uow.run(async ({ webhooks }) => {
        const now = this.deps.clock.now();
        const updated = result.ok
          ? event.recordSuccess(now)
          : event.recordFailure(now, this.deps.backoffSeconds);
        const props = updated.toProps();
        await webhooks.save(updated);
        await webhooks.recordAttempt({
          eventId: props.eventId,
          attemptNo: props.attempts,
          attemptedAt: now,
          statusCode: result.statusCode ?? null,
          error: result.ok ? null : (result.error ?? null),
        });
        return props.status;
      });

      if (status === 'DELIVERED') report.delivered += 1;
      else if (status === 'PENDING') report.retrying += 1;
      else report.failed += 1;

      // webhook=duplicate: gửi thêm một bản giống hệt, không tính vào lần thử và không ảnh hưởng trạng thái.
      if (result.ok && event.toProps().sendTwice) {
        await this.deps.sender.send(event, this.deps.clock.now());
      }
    }
    return report;
  }
}
```

- [ ] **Step 9: Chạy test, lint, typecheck**

Run: `corepack pnpm test:integration deliver-due-webhooks && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS (8 test). Nếu ca "retries on the backoff schedule" lệch ở `next_attempt_at`, kiểm tra rằng `clock.now()` trong test không bị đẩy giữa `claim` và `recordFailure` (FakeClock chỉ đổi khi test gọi `advance*`).

- [ ] **Step 10: Commit**

```bash
git add services/payment
git commit -m "feat(payment): add HTTP webhook sender and DeliverDueWebhooks with lease and backoff"
```

### Task 10: Use case `GetCharge` và `GetSettlement`

**Files:**
- Create: `services/payment/src/application/get-charge.ts`, `application/get-settlement.ts`
- Test: `services/payment/src/application/get-charge.integration.test.ts`, `application/get-settlement.integration.test.ts`

**Interfaces:**
- Consumes: `UnitOfWork`, `Clock`, `ChargeNotFoundError`, `InvalidSettlementQueryError`, `SettlementTotal`, `CompletedCursor` (Task 6); `toChargeView`, `ChargeView` (Task 7).
- Produces:
  - `class GetCharge { constructor(deps: { uow: UnitOfWork }); execute(id: string): Promise<ChargeView> }` — ném `ChargeNotFoundError`
  - `interface SettlementQuery { date: string; limit?: number | undefined; cursor?: string | undefined }`
  - `interface SettlementItem { chargeId: string; reference: string; amount: number; currency: string; status: 'SUCCEEDED' | 'FAILED'; failureCode?: string; completedAt: string }`
  - `interface SettlementView { date: string; items: SettlementItem[]; nextCursor: string | null; totals: SettlementTotal[] }`
  - `class GetSettlement { constructor(deps: { uow: UnitOfWork; clock: Clock }); execute(query: SettlementQuery): Promise<SettlementView> }` — ném `InvalidSettlementQueryError` khi `date` sai định dạng / không phải ngày lịch hợp lệ / ở tương lai (so với ngày UTC của `clock`; hôm nay được phép), `limit` không phải số nguyên `1..1000` (mặc định 500), hoặc `cursor` hỏng. `totals` tính trên **toàn ngày**, không theo trang. Cursor là chuỗi base64url của `{ c: <ISO completed_at>, i: <chargeId> }`.

- [ ] **Step 1: Viết test thất bại**

`services/payment/src/application/get-charge.integration.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { ChargeNotFoundError } from './errors.js';
import { GetCharge } from './get-charge.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let getCharge: GetCharge;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
  getCharge = new GetCharge({ uow: h.uow });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetTables(h.db);
  h.clock.set('2026-10-09T10:00:00.000Z');
});

const create = (key: string, simulate?: string) =>
  createCharge.execute({ idempotencyKey: key, amount: 1000, currency: 'VND', reference: `ref-${key}`, simulate });

describe('GetCharge', () => {
  it('shows a pending charge without completion fields', async () => {
    const { body } = await create('a', 'delay=10');
    expect(await getCharge.execute(body.chargeId)).toStrictEqual({
      chargeId: body.chargeId,
      reference: 'ref-a',
      amount: 1000,
      currency: 'VND',
      status: 'PENDING',
      createdAt: '2026-10-09T10:00:00.000Z',
    });
  });

  it('shows the outcome of a completed and of a failed charge', async () => {
    const ok = await create('a');
    const failed = await create('b', 'fail=card_declined');
    h.clock.advanceSeconds(1);
    await completeDue.execute();

    expect(await getCharge.execute(ok.body.chargeId)).toMatchObject({
      status: 'SUCCEEDED',
      completedAt: '2026-10-09T10:00:01.000Z',
    });
    expect(await getCharge.execute(ok.body.chargeId)).not.toHaveProperty('failureCode');
    expect(await getCharge.execute(failed.body.chargeId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'card_declined',
    });
  });

  it('throws ChargeNotFoundError for an unknown id', async () => {
    await expect(getCharge.execute('ch_nope')).rejects.toBeInstanceOf(ChargeNotFoundError);
  });
});
```

`services/payment/src/application/get-settlement.integration.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, resetTables, type Harness } from '../test-support.js';
import { CompleteDueCharges } from './complete-due-charges.js';
import { CreateCharge } from './create-charge.js';
import { InvalidSettlementQueryError } from './errors.js';
import { GetSettlement } from './get-settlement.js';

let h: Harness;
let createCharge: CreateCharge;
let completeDue: CompleteDueCharges;
let getSettlement: GetSettlement;

beforeAll(async () => {
  h = await createHarness();
  createCharge = new CreateCharge({ uow: h.uow, clock: h.clock, ids: h.ids });
  completeDue = new CompleteDueCharges({ uow: h.uow, clock: h.clock, ids: h.ids });
  getSettlement = new GetSettlement({ uow: h.uow, clock: h.clock });
});
afterAll(async () => {
  await h.close();
});

async function complete(
  at: string,
  key: string,
  options: { simulate?: string; amount?: number; currency?: string } = {},
): Promise<string> {
  h.clock.set(at);
  const { body } = await createCharge.execute({
    idempotencyKey: key,
    amount: options.amount ?? 1000,
    currency: options.currency ?? 'VND',
    reference: `ref-${key}`,
    simulate: options.simulate,
  });
  await completeDue.execute();
  return body.chargeId;
}

let c1: string;
let c2: string;
let c3: string;
let c4: string;

beforeEach(async () => {
  await resetTables(h.db);
  c1 = await complete('2026-10-09T23:59:59.900Z', 'a', { amount: 1000 });
  c2 = await complete('2026-10-10T00:00:00.000Z', 'b', { amount: 2500, simulate: 'fail=card_declined' });
  c3 = await complete('2026-10-10T00:00:00.000Z', 'c', { amount: 4000 });
  c4 = await complete('2026-10-10T08:00:00.000Z', 'd', { amount: 500, currency: 'USD' });
  // Một charge còn PENDING: không được xuất hiện trong sao kê.
  h.clock.set('2026-10-10T09:00:00.000Z');
  await createCharge.execute({
    idempotencyKey: 'e',
    amount: 9999,
    currency: 'VND',
    reference: 'ref-e',
    simulate: 'delay=100',
  });
  h.clock.set('2026-10-11T12:00:00.000Z');
});

const ids = (view: { items: Array<{ chargeId: string }> }) => view.items.map((i) => i.chargeId);

describe('GetSettlement', () => {
  it('lists the charges completed on that UTC day, with totals', async () => {
    const day1 = await getSettlement.execute({ date: '2026-10-09' });
    expect(ids(day1)).toEqual([c1]);
    expect(day1.nextCursor).toBeNull();
    expect(day1.totals).toEqual([{ currency: 'VND', status: 'SUCCEEDED', count: 1, totalAmount: 1000 }]);

    const day2 = await getSettlement.execute({ date: '2026-10-10' });
    expect(ids(day2)).toEqual([c2, c3, c4]);
    expect(day2.items[0]).toEqual({
      chargeId: c2,
      reference: 'ref-b',
      amount: 2500,
      currency: 'VND',
      status: 'FAILED',
      failureCode: 'card_declined',
      completedAt: '2026-10-10T00:00:00.000Z',
    });
    expect(day2.items[1]).not.toHaveProperty('failureCode');
    expect(day2.totals).toEqual([
      { currency: 'USD', status: 'SUCCEEDED', count: 1, totalAmount: 500 },
      { currency: 'VND', status: 'FAILED', count: 1, totalAmount: 2500 },
      { currency: 'VND', status: 'SUCCEEDED', count: 1, totalAmount: 4000 },
    ]);
  });

  it('puts a charge completed at 00:00:00.000 in the new day, not the previous one', async () => {
    expect(ids(await getSettlement.execute({ date: '2026-10-09' }))).not.toContain(c2);
  });

  it('returns an empty list and no totals for a day without charges', async () => {
    expect(await getSettlement.execute({ date: '2026-10-08' })).toEqual({
      date: '2026-10-08',
      items: [],
      nextCursor: null,
      totals: [],
    });
  });

  it('pages with a cursor, tie-breaking equal timestamps by id, and keeps whole-day totals', async () => {
    const first = await getSettlement.execute({ date: '2026-10-10', limit: 2 });
    expect(ids(first)).toEqual([c2, c3]);
    expect(first.nextCursor).not.toBeNull();

    const second = await getSettlement.execute({
      date: '2026-10-10',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(ids(second)).toEqual([c4]);
    expect(second.nextCursor).toBeNull();
    expect(second.totals).toEqual(first.totals);
  });

  it('walks the whole day one item at a time without skipping or repeating', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const view = await getSettlement.execute({ date: '2026-10-10', limit: 1, cursor });
      seen.push(...ids(view));
      if (view.nextCursor === null) break;
      cursor = view.nextCursor;
    }
    expect(seen).toEqual([c2, c3, c4]);
  });

  it('has no next page when the limit exactly matches the number of items', async () => {
    const view = await getSettlement.execute({ date: '2026-10-10', limit: 3 });
    expect(ids(view)).toHaveLength(3);
    expect(view.nextCursor).toBeNull();
  });

  it('accepts today and rejects tomorrow (UTC)', async () => {
    h.clock.set('2026-10-10T12:00:00.000Z');
    await expect(getSettlement.execute({ date: '2026-10-10' })).resolves.toBeDefined();
    await expect(getSettlement.execute({ date: '2026-10-11' })).rejects.toBeInstanceOf(
      InvalidSettlementQueryError,
    );
  });

  it.each(['2026-13-01', '2026-02-30', 'abcd', '', '2026-1-1', '2026-10-09T00:00:00Z'])(
    'rejects the invalid date %j',
    async (date) => {
      await expect(getSettlement.execute({ date })).rejects.toBeInstanceOf(InvalidSettlementQueryError);
    },
  );

  it.each([0, 1001, 1.5, Number.NaN, -1])('rejects the invalid limit %d', async (limit) => {
    await expect(getSettlement.execute({ date: '2026-10-10', limit })).rejects.toBeInstanceOf(
      InvalidSettlementQueryError,
    );
  });

  it.each([
    'not-base64!',
    Buffer.from('{}').toString('base64url'),
    Buffer.from('not json').toString('base64url'),
    Buffer.from(JSON.stringify({ c: 'yesterday', i: 'x' })).toString('base64url'),
    Buffer.from(JSON.stringify({ c: '2026-10-10T00:00:00.000Z', i: '' })).toString('base64url'),
  ])('rejects the invalid cursor %j', async (cursor) => {
    await expect(getSettlement.execute({ date: '2026-10-10', cursor })).rejects.toBeInstanceOf(
      InvalidSettlementQueryError,
    );
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm test:integration get-charge get-settlement`
Expected: FAIL (không resolve được `./get-charge.js`, `./get-settlement.js`).

- [ ] **Step 3: Cài code**

`services/payment/src/application/get-charge.ts`:
```ts
import { ChargeNotFoundError } from './errors.js';
import type { UnitOfWork } from './ports.js';
import { toChargeView, type ChargeView } from './views.js';

export class GetCharge {
  constructor(private readonly deps: { uow: UnitOfWork }) {}

  async execute(id: string): Promise<ChargeView> {
    const charge = await this.deps.uow.run(({ charges }) => charges.findById(id));
    if (!charge) throw new ChargeNotFoundError(`charge ${id} not found`);
    return toChargeView(charge);
  }
}
```

`services/payment/src/application/get-settlement.ts`:
```ts
import { InvalidSettlementQueryError } from './errors.js';
import type { Clock, CompletedCursor, SettlementTotal, UnitOfWork } from './ports.js';

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SettlementQuery {
  date: string;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SettlementItem {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: 'SUCCEEDED' | 'FAILED';
  failureCode?: string;
  completedAt: string;
}

export interface SettlementView {
  date: string;
  items: SettlementItem[];
  nextCursor: string | null;
  totals: SettlementTotal[];
}

function parseDay(date: string, now: Date): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new InvalidSettlementQueryError('date must be formatted as YYYY-MM-DD');
  }
  const from = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== date) {
    throw new InvalidSettlementQueryError('date is not a valid calendar date');
  }
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (from.getTime() > startOfToday) {
    throw new InvalidSettlementQueryError('date must not be in the future');
  }
  return from;
}

function parseLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidSettlementQueryError(`limit must be an integer in 1..${MAX_LIMIT}`);
  }
  return limit;
}

function encodeCursor(cursor: CompletedCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.completedAt.toISOString(), i: cursor.id })).toString(
    'base64url',
  );
}

function decodeCursor(raw: string): CompletedCursor {
  const invalid = () => new InvalidSettlementQueryError('cursor is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== 'string' || typeof i !== 'string' || i === '') throw invalid();
  const completedAt = new Date(c);
  if (Number.isNaN(completedAt.getTime()) || completedAt.toISOString() !== c) throw invalid();
  return { completedAt, id: i };
}

export class GetSettlement {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  async execute(query: SettlementQuery): Promise<SettlementView> {
    const from = parseDay(query.date, this.deps.clock.now());
    const limit = parseLimit(query.limit);
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const to = new Date(from.getTime() + DAY_MS);

    const { rows, totals } = await this.deps.uow.run(async ({ charges }) => ({
      // Lấy dư một dòng để biết còn trang sau hay không.
      rows: await charges.listCompleted({ from, to, limit: limit + 1, after }),
      totals: await charges.totals({ from, to }),
    }));

    const page = rows.slice(0, limit);
    const items: SettlementItem[] = page.map((charge) => {
      const p = charge.toProps();
      return {
        chargeId: p.id,
        reference: p.reference,
        amount: p.amount.amount,
        currency: p.amount.currency,
        status: p.status as 'SUCCEEDED' | 'FAILED',
        ...(p.failureCode === null ? {} : { failureCode: p.failureCode }),
        completedAt: (p.completedAt ?? p.createdAt).toISOString(),
      };
    });

    const last = page.at(-1)?.toProps();
    const nextCursor =
      rows.length > limit && last?.completedAt
        ? encodeCursor({ completedAt: last.completedAt, id: last.id })
        : null;

    return { date: query.date, items, nextCursor, totals };
  }
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm test:integration get-charge get-settlement && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS. Nếu ca phân trang bỏ sót hoặc lặp một charge có cùng `completed_at`, kiểm tra điều kiện `eb.and([completed_at = at, id > afterId])` trong `KyselyChargeRepository.listCompleted`.

- [ ] **Step 5: Commit**

```bash
git add services/payment
git commit -m "feat(payment): add GetCharge and GetSettlement with cursor paging"
```

---

### Task 11: Worker, đồng hồ/ID hệ thống và cấu hình

**Files:**
- Create: `services/payment/src/infrastructure/worker.ts`, `infrastructure/system.ts`, `services/payment/src/config.ts`
- Test: `services/payment/src/infrastructure/worker.test.ts`, `infrastructure/system.test.ts`, `services/payment/src/config.test.ts`

**Interfaces:**
- Consumes: `Clock`, `IdGenerator` (Task 6); `ConfigError`, `databaseConfigFromEnv`, `DatabaseConfig` (Task 1).
- Produces:
  - `interface WorkerOptions { intervalMs: number; tasks: ReadonlyArray<() => Promise<unknown>>; onError: (error: unknown) => void }`
  - `class Worker { constructor(options: WorkerOptions); tick(): Promise<void>; start(): void; stop(): Promise<void> }` — `tick()` chạy lần lượt các task, task lỗi chỉ báo qua `onError` rồi tiếp tục; `start()` chạy tick đầu ngay rồi lặp sau mỗi `intervalMs` (không chồng lấn); `stop()` chờ tick đang chạy
  - `class SystemClock implements Clock`, `class RandomIdGenerator implements IdGenerator` (`ch_<32 hex>`, `evt_<32 hex>`)
  - `interface PaymentConfig { port: number; database: DatabaseConfig; webhook: { url: string; secret: string; backoffSeconds: number[] }; workerIntervalMs: number; responseTimeoutMs: number }`
  - `loadConfig(env: NodeJS.ProcessEnv): PaymentConfig` — ném `ConfigError` liệt kê mọi vấn đề cùng lúc

- [ ] **Step 1: Viết test thất bại**

`services/payment/src/infrastructure/worker.test.ts`:
```ts
import { waitFor } from '@billing/testing';
import { describe, expect, it } from 'vitest';
import { Worker } from './worker.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Worker', () => {
  it('runs every task on a tick, in order', async () => {
    const order: string[] = [];
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [async () => void order.push('a'), async () => void order.push('b')],
      onError: () => undefined,
    });
    await worker.tick();
    expect(order).toEqual(['a', 'b']);
  });

  it('reports a failing task and still runs the next one', async () => {
    const errors: unknown[] = [];
    let ran = false;
    const boom = new Error('boom');
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [
        async () => {
          throw boom;
        },
        async () => {
          ran = true;
        },
      ],
      onError: (error) => errors.push(error),
    });
    await worker.tick();
    expect(errors).toEqual([boom]);
    expect(ran).toBe(true);
  });

  it('repeats after start() and stops for good after stop()', async () => {
    let runs = 0;
    const worker = new Worker({ intervalMs: 5, tasks: [async () => void runs++], onError: () => undefined });
    worker.start();
    await waitFor(() => runs >= 3, { timeoutMs: 2000, intervalMs: 5 });
    await worker.stop();
    const afterStop = runs;
    await sleep(60);
    expect(runs).toBe(afterStop);
  });

  it('stop() waits for the tick that is running', async () => {
    let finished = false;
    const worker = new Worker({
      intervalMs: 1000,
      tasks: [
        async () => {
          await sleep(60);
          finished = true;
        },
      ],
      onError: () => undefined,
    });
    worker.start();
    await sleep(10);
    await worker.stop();
    expect(finished).toBe(true);
  });

  it('never overlaps two ticks', async () => {
    let active = 0;
    let maxActive = 0;
    const worker = new Worker({
      intervalMs: 1,
      tasks: [
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await sleep(15);
          active--;
        },
      ],
      onError: () => undefined,
    });
    worker.start();
    await sleep(100);
    await worker.stop();
    expect(maxActive).toBe(1);
  });
});
```

`services/payment/src/infrastructure/system.test.ts`:
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
    const charges = new Set(Array.from({ length: 50 }, () => ids.chargeId()));
    expect(charges.size).toBe(50);
    for (const id of charges) expect(id).toMatch(/^ch_[0-9a-f]{32}$/);
    expect(ids.eventId()).toMatch(/^evt_[0-9a-f]{32}$/);
  });
});
```

`services/payment/src/config.test.ts`:
```ts
import { ConfigError } from '@billing/database';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const minimal = {
  PAYMENT_DB_HOST: 'db',
  PAYMENT_DB_NAME: 'billing_payment',
  PAYMENT_DB_USER: 'u',
  PAYMENT_DB_PASSWORD: 'p',
  WEBHOOK_URL: 'http://wallet:3001/webhooks/payment',
  WEBHOOK_SECRET: 'whsec_x',
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
  it('applies documented defaults', () => {
    expect(loadConfig(minimal)).toEqual({
      port: 3002,
      database: { host: 'db', port: 1433, database: 'billing_payment', user: 'u', password: 'p' },
      webhook: {
        url: 'http://wallet:3001/webhooks/payment',
        secret: 'whsec_x',
        backoffSeconds: [1, 5, 30, 120, 600],
      },
      workerIntervalMs: 500,
      responseTimeoutMs: 30000,
    });
  });

  it('reads overrides', () => {
    const config = loadConfig({
      ...minimal,
      PORT: '4000',
      PAYMENT_DB_PORT: '14333',
      WEBHOOK_BACKOFF: '2, 4,8',
      WORKER_INTERVAL_MS: '50',
      RESPONSE_TIMEOUT_MS: '100',
    });
    expect(config).toMatchObject({
      port: 4000,
      database: { port: 14333 },
      webhook: { backoffSeconds: [2, 4, 8] },
      workerIntervalMs: 50,
      responseTimeoutMs: 100,
    });
  });

  it('refuses to start without the required settings and lists all of them', () => {
    expect(problemsOf({})).toEqual([
      'PAYMENT_DB_HOST is required',
      'PAYMENT_DB_NAME is required',
      'PAYMENT_DB_USER is required',
      'PAYMENT_DB_PASSWORD is required',
      'WEBHOOK_URL is required',
      'WEBHOOK_SECRET is required',
    ]);
  });

  it('has no default for the secret and treats blank as missing', () => {
    expect(problemsOf({ ...minimal, WEBHOOK_SECRET: '   ' })).toEqual(['WEBHOOK_SECRET is required']);
  });

  it.each(['ftp://x', 'not a url', 'wallet:3001'])('rejects WEBHOOK_URL %j', (url) => {
    expect(problemsOf({ ...minimal, WEBHOOK_URL: url })).toEqual([
      'WEBHOOK_URL must be an absolute http(s) URL',
    ]);
  });

  it.each(['', '1,a', '0', '-1', '1.5', '1,,2'])('rejects WEBHOOK_BACKOFF %j', (value) => {
    const problems = problemsOf({ ...minimal, WEBHOOK_BACKOFF: value });
    // Chuỗi rỗng được coi như không đặt (dùng mặc định).
    expect(problems).toEqual(value === '' ? [] : ['WEBHOOK_BACKOFF must be a comma-separated list of positive integers (seconds)']);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['WORKER_INTERVAL_MS', '0'],
    ['WORKER_INTERVAL_MS', 'abc'],
    ['RESPONSE_TIMEOUT_MS', '-1'],
    ['RESPONSE_TIMEOUT_MS', 'abc'],
  ])('rejects %s=%s', (name, value) => {
    expect(problemsOf({ ...minimal, [name]: value })).toHaveLength(1);
  });

  it('reports a bad database port together with the other problems', () => {
    expect(problemsOf({ ...minimal, PAYMENT_DB_PORT: 'x', WEBHOOK_SECRET: '' })).toEqual([
      'PAYMENT_DB_PORT must be an integer in 1..65535',
      'WEBHOOK_SECRET is required',
    ]);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/payment/src/infrastructure/worker.test.ts services/payment/src/infrastructure/system.test.ts services/payment/src/config.test.ts`
Expected: FAIL (không resolve được các module).

- [ ] **Step 3: Cài code**

`services/payment/src/infrastructure/worker.ts`:
```ts
export interface WorkerOptions {
  intervalMs: number;
  tasks: ReadonlyArray<() => Promise<unknown>>;
  onError: (error: unknown) => void;
}

/** Vòng lặp nền đơn giản: chạy các task lần lượt, không bao giờ chồng hai tick, dừng êm. */
export class Worker {
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #inflight: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkerOptions) {}

  async tick(): Promise<void> {
    for (const task of this.options.tasks) {
      try {
        await task();
      } catch (error) {
        this.options.onError(error);
      }
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = (): void => {
      this.#inflight = this.tick().finally(() => {
        if (this.#running) this.#timer = setTimeout(loop, this.options.intervalMs);
      });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
    await this.#inflight;
  }
}
```

`services/payment/src/infrastructure/system.ts`:
```ts
import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '../application/ports.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export class RandomIdGenerator implements IdGenerator {
  chargeId(): string {
    return `ch_${randomUUID().replaceAll('-', '')}`;
  }

  eventId(): string {
    return `evt_${randomUUID().replaceAll('-', '')}`;
  }
}
```

`services/payment/src/config.ts`:
```ts
import { ConfigError, databaseConfigFromEnv, type DatabaseConfig } from '@billing/database';

export interface PaymentConfig {
  port: number;
  database: DatabaseConfig;
  webhook: { url: string; secret: string; backoffSeconds: number[] };
  workerIntervalMs: number;
  responseTimeoutMs: number;
}

const DEFAULT_BACKOFF = '1,5,30,120,600';

/** Đọc cấu hình từ môi trường; thiếu hoặc sai thì ném ConfigError liệt kê mọi vấn đề cùng lúc. */
export function loadConfig(env: NodeJS.ProcessEnv): PaymentConfig {
  const problems: string[] = [];

  let database: DatabaseConfig | undefined;
  try {
    database = databaseConfigFromEnv('PAYMENT_DB', env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    problems.push(...error.problems);
  }

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

  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };

  const url = required('WEBHOOK_URL');
  if (url !== '') {
    let valid = false;
    try {
      const parsed = new URL(url);
      valid = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      valid = false;
    }
    if (!valid) problems.push('WEBHOOK_URL must be an absolute http(s) URL');
  }
  const secret = required('WEBHOOK_SECRET');

  const rawBackoff = env.WEBHOOK_BACKOFF;
  const backoffText = rawBackoff === undefined || rawBackoff.trim() === '' ? DEFAULT_BACKOFF : rawBackoff;
  const backoffParts = backoffText.split(',').map((part) => part.trim());
  const backoffSeconds = backoffParts.every((part) => /^[1-9]\d{0,5}$/.test(part))
    ? backoffParts.map(Number)
    : undefined;
  if (backoffSeconds === undefined) {
    problems.push('WEBHOOK_BACKOFF must be a comma-separated list of positive integers (seconds)');
  }

  const port = integer('PORT', 3002, 1, 65535);
  const workerIntervalMs = integer('WORKER_INTERVAL_MS', 500, 1, 3_600_000);
  const responseTimeoutMs = integer('RESPONSE_TIMEOUT_MS', 30_000, 0, 3_600_000);

  if (problems.length > 0 || database === undefined || backoffSeconds === undefined) {
    throw new ConfigError(problems);
  }
  return {
    port,
    database,
    webhook: { url, secret, backoffSeconds },
    workerIntervalMs,
    responseTimeoutMs,
  };
}
```

- [ ] **Step 4: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run services/payment && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS. Ghi chú: thứ tự `problems` của `loadConfig` là DB trước, rồi `WEBHOOK_URL`, `WEBHOOK_SECRET`, `WEBHOOK_BACKOFF`, `PORT`, `WORKER_INTERVAL_MS`, `RESPONSE_TIMEOUT_MS`; các test ở trên phụ thuộc đúng thứ tự này.

- [ ] **Step 5: Commit**

```bash
git add services/payment
git commit -m "feat(payment): add background worker, system clock/ids and env config"
```

### Task 12: Giao diện HTTP và nối dây (composition root)

**Files:**
- Create: `services/payment/src/interface/http/errors.ts`, `charges.route.ts`, `settlements.route.ts`, `stub-deps.ts`
- Modify: `services/payment/src/interface/http/app.ts` (viết lại toàn bộ), `app.test.ts` (hai chỗ), `services/payment/src/main.ts` (viết lại toàn bộ)
- Create: `services/payment/src/bootstrap.ts`
- Test: `services/payment/src/interface/http/charges.route.test.ts`, `settlements.route.test.ts`

**Interfaces:**
- Consumes: mọi use case (Task 7–10), `Worker`, `SystemClock`, `RandomIdGenerator` (Task 11), `HttpWebhookSender` (Task 9), `KyselyUnitOfWork`, `PaymentDatabase` (Task 6), `PaymentConfig` (Task 11).
- Produces:
  - `interface AppDependencies { createCharge: Pick<CreateCharge, 'execute'>; getCharge: Pick<GetCharge, 'execute'>; getSettlement: Pick<GetSettlement, 'execute'>; responseTimeoutMs: number; sleep?: (ms: number) => Promise<void>; log?: ErrorLogger }`
  - `buildApp(deps: AppDependencies): Promise<FastifyInstance>` (thay cho `buildApp()` cũ)
  - `interface ErrorLogger { error(details: object, message?: string): void }`; `class RequestValidationError extends Error { readonly code: string }`; `mapError(error: unknown): { status: number; code: string; message: string }`
  - `stubDeps(overrides?: Partial<AppDependencies>): AppDependencies` (cho test, mọi use case ném lỗi nếu bị gọi)
  - `startService(config: PaymentConfig, overrides?: { clock?: Clock; ids?: IdGenerator }): Promise<RunningService>` với `interface RunningService { app: FastifyInstance; stop(): Promise<void> }`; app chưa `listen`; worker đã chạy
- Định dạng lỗi HTTP: `{ "error": { "code": "<MÃ>", "message": "<mô tả>" } }`. Mã: `MISSING_IDEMPOTENCY_KEY`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_REQUEST`, `INVALID_SIMULATE` (`400`); `IDEMPOTENCY_KEY_REUSED` (`422`); `CHARGE_NOT_FOUND`, `NOT_FOUND` (`404`); `INVALID_QUERY` (`400`); `INTERNAL` (`500`, không lộ thông điệp gốc).

- [ ] **Step 1: Viết test thất bại**

`services/payment/src/interface/http/stub-deps.ts`:
```ts
import type { AppDependencies } from './app.js';

const unexpected = {
  execute: async (): Promise<never> => {
    throw new Error('unexpected call');
  },
};

/** Phụ thuộc giả cho test HTTP: use case nào không được test chủ động ghi đè sẽ ném lỗi khi bị gọi. */
export function stubDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    createCharge: unexpected,
    getCharge: unexpected,
    getSettlement: unexpected,
    responseTimeoutMs: 20,
    ...overrides,
  };
}
```

Sửa `services/payment/src/interface/http/app.test.ts`: thay dòng `import { buildApp } from './app.js';` bằng
```ts
import { buildApp } from './app.js';
import { stubDeps } from './stub-deps.js';
```
và thay dòng `app = await buildApp();` bằng `app = await buildApp(stubDeps());`.

`services/payment/src/interface/http/charges.route.test.ts`:
```ts
import { InvalidMoneyError } from '@billing/money';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CreateChargeInput, CreateChargeResult } from '../../application/create-charge.js';
import { ChargeNotFoundError, IdempotencyConflictError } from '../../application/errors.js';
import { InvalidChargeError } from '../../domain/errors.js';
import { InvalidScenarioError } from '../../domain/scenario.js';
import { buildApp, type AppDependencies } from './app.js';
import { stubDeps } from './stub-deps.js';

const created: CreateChargeResult = {
  status: 202,
  replayed: false,
  responseTimeout: false,
  body: {
    chargeId: 'ch_1',
    reference: 'topup-1',
    amount: 150000,
    currency: 'VND',
    status: 'PENDING',
    createdAt: '2026-10-09T10:00:00.000Z',
  },
};
const validBody = { amount: 150000, currency: 'VND', reference: 'topup-1' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<AppDependencies> = {}): Promise<FastifyInstance> {
  app = await buildApp(stubDeps(overrides));
  return app;
}

function post(
  server: FastifyInstance,
  options: { headers?: Record<string, string>; payload?: string } = {},
) {
  return server.inject({
    method: 'POST',
    url: '/charges',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k1', ...options.headers },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
}

const failWith = (error: Error): Partial<AppDependencies> => ({
  createCharge: {
    execute: async () => {
      throw error;
    },
  },
});

describe('POST /charges', () => {
  it('forwards a valid request to the use case and answers with its result', async () => {
    const execute = vi.fn(async (_input: CreateChargeInput) => created);
    const server = await start({ createCharge: { execute } });
    const res = await post(server, {
      headers: { 'x-simulate': 'delay=3' },
      payload: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(created.body);
    expect(res.headers['x-correlation-id']).toBeTruthy();
    expect(execute).toHaveBeenCalledWith({
      idempotencyKey: 'k1',
      amount: 150000,
      currency: 'VND',
      reference: 'topup-1',
      simulate: 'delay=3',
    });
  });

  it('passes no simulation when X-Simulate is absent', async () => {
    const execute = vi.fn(async (_input: CreateChargeInput) => created);
    const server = await start({ createCharge: { execute } });
    await post(server, { payload: JSON.stringify(validBody) });
    expect(execute.mock.calls[0]?.[0].simulate).toBeUndefined();
  });

  it('replays the stored status and body', async () => {
    const server = await start({
      createCharge: { execute: async () => ({ ...created, replayed: true }) },
    });
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(created.body);
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
  ])('rejects an %s Idempotency-Key', async (_name, key) => {
    const execute = vi.fn(async (_input: CreateChargeInput) => created);
    const server = await start({ createCharge: { execute } });
    const res = await server.inject({
      method: 'POST',
      url: '/charges',
      headers: { 'content-type': 'application/json', ...(key === undefined ? {} : { 'idempotency-key': key }) },
      payload: JSON.stringify(validBody),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'MISSING_IDEMPOTENCY_KEY', message: expect.any(String) },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('accepts a 255-character Idempotency-Key and rejects 256', async () => {
    const execute = vi.fn(async (_input: CreateChargeInput) => created);
    const server = await start({ createCharge: { execute } });
    const ok = await post(server, {
      headers: { 'idempotency-key': 'k'.repeat(255) },
      payload: JSON.stringify(validBody),
    });
    expect(ok.statusCode).toBe(202);
    const tooLong = await post(server, {
      headers: { 'idempotency-key': 'k'.repeat(256) },
      payload: JSON.stringify(validBody),
    });
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it.each([
    ['malformed JSON', '{bad'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string amount', JSON.stringify({ ...validBody, amount: '150000' })],
    ['a missing currency', JSON.stringify({ amount: 1, reference: 'x' })],
    ['a missing reference', JSON.stringify({ amount: 1, currency: 'VND' })],
    ['a non-string reference', JSON.stringify({ ...validBody, reference: 7 })],
  ])('rejects %s with INVALID_REQUEST without calling the use case', async (_name, payload) => {
    const execute = vi.fn(async (_input: CreateChargeInput) => created);
    const server = await start({ createCharge: { execute } });
    const res = await post(server, { payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const server = await start();
    const res = await post(server);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REQUEST');
  });

  it.each([
    ['an invalid scenario', new InvalidScenarioError('unknown key "x"'), 400, 'INVALID_SIMULATE'],
    ['an invalid amount', new InvalidMoneyError('amount must be a safe integer'), 400, 'INVALID_REQUEST'],
    ['an invalid charge', new InvalidChargeError('reference must be 1..200 characters'), 400, 'INVALID_REQUEST'],
    ['a reused key', new IdempotencyConflictError('key reused'), 422, 'IDEMPOTENCY_KEY_REUSED'],
  ])('maps %s to its HTTP status and error code', async (_name, error, status, code) => {
    const server = await start(failWith(error));
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: error.message } });
  });

  it('hides the cause of an unexpected error but logs it', async () => {
    const log = { error: vi.fn() };
    const server = await start({ ...failWith(new Error('db exploded: secret')), log });
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal server error' } });
    expect(res.body).not.toContain('secret');
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('holds the response for response=timeout on the first call only', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    const timedOut = { ...created, responseTimeout: true };
    const server = await start({
      createCharge: { execute: async () => timedOut },
      responseTimeoutMs: 1234,
      sleep,
    });
    const res = await post(server, { payload: JSON.stringify(validBody) });
    expect(res.statusCode).toBe(202);
    expect(sleep).toHaveBeenCalledWith(1234);

    sleep.mockClear();
    const replayServer = await buildApp(
      stubDeps({ createCharge: { execute: async () => created }, sleep }),
    );
    await post(replayServer, { payload: JSON.stringify(validBody) });
    expect(sleep).not.toHaveBeenCalled();
    await replayServer.close();
  });
});

describe('GET /charges/:id', () => {
  it('returns the charge the use case found', async () => {
    const view = { ...created.body, status: 'SUCCEEDED' as const, completedAt: '2026-10-09T10:00:01.000Z' };
    const execute = vi.fn(async (_id: string) => view);
    const server = await start({ getCharge: { execute } });
    const res = await server.inject({ method: 'GET', url: '/charges/ch_1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(execute).toHaveBeenCalledWith('ch_1');
  });

  it('answers 404 CHARGE_NOT_FOUND', async () => {
    const server = await start({
      getCharge: {
        execute: async () => {
          throw new ChargeNotFoundError('charge ch_x not found');
        },
      },
    });
    const res = await server.inject({ method: 'GET', url: '/charges/ch_x' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CHARGE_NOT_FOUND');
  });
});

describe('unknown routes', () => {
  it('answer 404 NOT_FOUND in the same error format', async () => {
    const server = await start();
    const res = await server.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
```

`services/payment/src/interface/http/settlements.route.test.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidSettlementQueryError } from '../../application/errors.js';
import type { SettlementQuery, SettlementView } from '../../application/get-settlement.js';
import { buildApp, type AppDependencies } from './app.js';
import { stubDeps } from './stub-deps.js';

const view: SettlementView = { date: '2026-10-10', items: [], nextCursor: null, totals: [] };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(overrides: Partial<AppDependencies>): Promise<FastifyInstance> {
  app = await buildApp(stubDeps(overrides));
  return app;
}

describe('GET /settlements', () => {
  it('forwards date, limit and cursor and returns the settlement', async () => {
    const execute = vi.fn(async (_query: SettlementQuery) => view);
    const server = await start({ getSettlement: { execute } });
    const res = await server.inject({ method: 'GET', url: '/settlements?date=2026-10-10&limit=2&cursor=abc' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(view);
    expect(execute).toHaveBeenCalledWith({ date: '2026-10-10', limit: 2, cursor: 'abc' });
  });

  it('leaves limit and cursor undefined when they are absent', async () => {
    const execute = vi.fn(async (_query: SettlementQuery) => view);
    const server = await start({ getSettlement: { execute } });
    await server.inject({ method: 'GET', url: '/settlements?date=2026-10-10' });
    const query = execute.mock.calls[0]?.[0];
    expect(query?.limit).toBeUndefined();
    expect(query?.cursor).toBeUndefined();
  });

  it('passes a non-numeric limit as NaN so the use case rejects it', async () => {
    const execute = vi.fn(async (_query: SettlementQuery) => view);
    const server = await start({ getSettlement: { execute } });
    await server.inject({ method: 'GET', url: '/settlements?date=2026-10-10&limit=abc' });
    expect(Number.isNaN(execute.mock.calls[0]?.[0].limit)).toBe(true);
  });

  it('passes an empty date through so the use case rejects it', async () => {
    const execute = vi.fn(async (_query: SettlementQuery) => view);
    const server = await start({ getSettlement: { execute } });
    await server.inject({ method: 'GET', url: '/settlements' });
    expect(execute.mock.calls[0]?.[0].date).toBe('');
  });

  it('maps an invalid query to 400 INVALID_QUERY', async () => {
    const server = await start({
      getSettlement: {
        execute: async () => {
          throw new InvalidSettlementQueryError('date must not be in the future');
        },
      },
    });
    const res = await server.inject({ method: 'GET', url: '/settlements?date=2999-01-01' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: { code: 'INVALID_QUERY', message: 'date must not be in the future' },
    });
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/payment/src/interface`
Expected: FAIL (`buildApp` chưa nhận tham số, thiếu `stub-deps` phụ thuộc, route chưa có).

- [ ] **Step 3: Cài lớp interface**

`services/payment/src/interface/http/errors.ts`:
```ts
import { InvalidMoneyError } from '@billing/money';
import type { FastifyInstance } from 'fastify';
import {
  ChargeNotFoundError,
  IdempotencyConflictError,
  InvalidSettlementQueryError,
} from '../../application/errors.js';
import { InvalidChargeError } from '../../domain/errors.js';
import { InvalidScenarioError } from '../../domain/scenario.js';

export interface ErrorLogger {
  error(details: object, message?: string): void;
}

/** Lỗi đầu vào HTTP do tầng interface tự phát hiện (header/body sai dạng). */
export class RequestValidationError extends Error {
  override name = 'RequestValidationError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HttpError {
  status: number;
  code: string;
  message: string;
}

export function mapError(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : 'unknown error';
  if (error instanceof RequestValidationError) return { status: 400, code: error.code, message };
  if (error instanceof InvalidScenarioError) return { status: 400, code: 'INVALID_SIMULATE', message };
  if (error instanceof InvalidMoneyError || error instanceof InvalidChargeError) {
    return { status: 400, code: 'INVALID_REQUEST', message };
  }
  if (error instanceof IdempotencyConflictError) {
    return { status: 422, code: 'IDEMPOTENCY_KEY_REUSED', message };
  }
  if (error instanceof ChargeNotFoundError) return { status: 404, code: 'CHARGE_NOT_FOUND', message };
  if (error instanceof InvalidSettlementQueryError) return { status: 400, code: 'INVALID_QUERY', message };

  // Lỗi 4xx do chính Fastify sinh ra (JSON hỏng, body rỗng, ...).
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return { status: statusCode, code: 'INVALID_REQUEST', message };
  }
  return { status: 500, code: 'INTERNAL', message: 'internal server error' };
}

export function registerErrorHandling(app: FastifyInstance, log?: ErrorLogger): void {
  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapError(error);
    if (mapped.status >= 500) log?.error({ err: error }, 'unhandled error');
    return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `route ${request.method} ${request.url} not found` },
    }),
  );
}
```

`services/payment/src/interface/http/charges.route.ts`:
```ts
import type { FastifyPluginAsync } from 'fastify';
import type { CreateCharge } from '../../application/create-charge.js';
import type { GetCharge } from '../../application/get-charge.js';
import { RequestValidationError } from './errors.js';

export interface ChargesRoutesOptions {
  createCharge: Pick<CreateCharge, 'execute'>;
  getCharge: Pick<GetCharge, 'execute'>;
  responseTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

const MAX_KEY_LENGTH = 255;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export const chargesRoutes: FastifyPluginAsync<ChargesRoutesOptions> = async (app, options) => {
  app.post('/charges', async (request, reply) => {
    const key = first(request.headers['idempotency-key']);
    if (key === undefined || key.trim() === '') {
      throw new RequestValidationError('MISSING_IDEMPOTENCY_KEY', 'Idempotency-Key header is required');
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new RequestValidationError(
        'INVALID_IDEMPOTENCY_KEY',
        `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
      );
    }

    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new RequestValidationError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    const { amount, currency, reference } = body as Record<string, unknown>;
    if (typeof amount !== 'number') {
      throw new RequestValidationError('INVALID_REQUEST', 'amount must be a number');
    }
    if (typeof currency !== 'string') {
      throw new RequestValidationError('INVALID_REQUEST', 'currency must be a string');
    }
    if (typeof reference !== 'string') {
      throw new RequestValidationError('INVALID_REQUEST', 'reference must be a string');
    }

    const result = await options.createCharge.execute({
      idempotencyKey: key,
      amount,
      currency,
      reference,
      simulate: first(request.headers['x-simulate']),
    });

    // response=timeout: charge đã được tạo nhưng phản hồi bị giữ lại để client thấy timeout.
    if (result.responseTimeout) await options.sleep(options.responseTimeoutMs);
    return reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { id: string } }>('/charges/:id', async (request) =>
    options.getCharge.execute(request.params.id),
  );
};
```

`services/payment/src/interface/http/settlements.route.ts`:
```ts
import type { FastifyPluginAsync } from 'fastify';
import type { GetSettlement } from '../../application/get-settlement.js';

export interface SettlementsRoutesOptions {
  getSettlement: Pick<GetSettlement, 'execute'>;
}

export const settlementsRoutes: FastifyPluginAsync<SettlementsRoutesOptions> = async (app, options) => {
  app.get('/settlements', async (request) => {
    const query = request.query as Record<string, unknown>;
    return options.getSettlement.execute({
      date: typeof query.date === 'string' ? query.date : '',
      // Không phải số thì thành NaN; use case từ chối và route trả 400 INVALID_QUERY.
      limit: query.limit === undefined ? undefined : Number(query.limit),
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    });
  });
};
```

Viết lại toàn bộ `services/payment/src/interface/http/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  runWithCorrelation,
} from '@billing/observability';
import type { CreateCharge } from '../../application/create-charge.js';
import type { GetCharge } from '../../application/get-charge.js';
import type { GetSettlement } from '../../application/get-settlement.js';
import { chargesRoutes } from './charges.route.js';
import { registerErrorHandling, type ErrorLogger } from './errors.js';
import { healthRoute } from './health.route.js';
import { settlementsRoutes } from './settlements.route.js';

export interface AppDependencies {
  createCharge: Pick<CreateCharge, 'execute'>;
  getCharge: Pick<GetCharge, 'execute'>;
  getSettlement: Pick<GetSettlement, 'execute'>;
  responseTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: ErrorLogger;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (request, reply, done) => {
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelation(correlationId, () => done());
  });

  registerErrorHandling(app, deps.log);

  await app.register(healthRoute);
  await app.register(chargesRoutes, {
    createCharge: deps.createCharge,
    getCharge: deps.getCharge,
    responseTimeoutMs: deps.responseTimeoutMs,
    sleep: deps.sleep ?? realSleep,
  });
  await app.register(settlementsRoutes, { getSettlement: deps.getSettlement });
  return app;
}
```

- [ ] **Step 4: Chạy test interface**

Run: `corepack pnpm exec vitest run services/payment/src/interface`
Expected: PASS (health cũ vẫn đạt với `stubDeps()`; các ca mới đạt).

- [ ] **Step 5: Nối dây dịch vụ**

`services/payment/src/bootstrap.ts`:
```ts
import { createDatabase } from '@billing/database';
import { createLogger } from '@billing/observability';
import type { FastifyInstance } from 'fastify';
import { CompleteDueCharges } from './application/complete-due-charges.js';
import { CreateCharge } from './application/create-charge.js';
import { DeliverDueWebhooks } from './application/deliver-due-webhooks.js';
import { GetCharge } from './application/get-charge.js';
import { GetSettlement } from './application/get-settlement.js';
import type { Clock, IdGenerator } from './application/ports.js';
import type { PaymentConfig } from './config.js';
import { HttpWebhookSender } from './infrastructure/http-webhook-sender.js';
import type { PaymentDatabase } from './infrastructure/kysely/schema.js';
import { KyselyUnitOfWork } from './infrastructure/kysely/unit-of-work.js';
import { RandomIdGenerator, SystemClock } from './infrastructure/system.js';
import { Worker } from './infrastructure/worker.js';
import { buildApp } from './interface/http/app.js';

export interface StartOverrides {
  clock?: Clock;
  ids?: IdGenerator;
}

export interface RunningService {
  app: FastifyInstance;
  stop(): Promise<void>;
}

/** Composition root: nối mọi thứ lại, chạy worker nền; app chưa `listen` (main.ts hoặc test tự làm). */
export async function startService(
  config: PaymentConfig,
  overrides: StartOverrides = {},
): Promise<RunningService> {
  const log = createLogger('payment');
  const db = createDatabase<PaymentDatabase>(config.database);
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new RandomIdGenerator();
  const uow = new KyselyUnitOfWork(db);
  const sender = new HttpWebhookSender({ url: config.webhook.url, secret: config.webhook.secret });

  const completeDue = new CompleteDueCharges({ uow, clock, ids });
  const deliver = new DeliverDueWebhooks({
    uow,
    sender,
    clock,
    backoffSeconds: config.webhook.backoffSeconds,
  });

  const app = await buildApp({
    createCharge: new CreateCharge({ uow, clock, ids }),
    getCharge: new GetCharge({ uow }),
    getSettlement: new GetSettlement({ uow, clock }),
    responseTimeoutMs: config.responseTimeoutMs,
    log,
  });

  const worker = new Worker({
    intervalMs: config.workerIntervalMs,
    tasks: [() => completeDue.execute(), () => deliver.execute()],
    onError: (error) => log.error({ err: error }, 'worker task failed'),
  });
  worker.start();

  return {
    app,
    async stop() {
      await worker.stop();
      await app.close();
      await db.destroy();
    },
  };
}
```

Viết lại toàn bộ `services/payment/src/main.ts`:
```ts
import { ConfigError } from '@billing/database';
import { createLogger } from '@billing/observability';
import { startService } from './bootstrap.js';
import { loadConfig, type PaymentConfig } from './config.js';

const log = createLogger('payment');

let config: PaymentConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    log.error({ problems: error.problems }, 'invalid configuration, refusing to start');
    process.exit(1);
  }
  throw error;
}

const service = await startService(config);
await service.app.listen({ port: config.port, host: '0.0.0.0' });
log.info({ port: config.port }, 'payment service listening');

const shutdown = (signal: string): void => {
  log.info({ signal }, 'shutting down');
  void service.stop().then(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 6: Chạy toàn bộ unit test, lint, typecheck**

Run: `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS. Lint xác nhận `interface/` không import `infrastructure/`, `application/` không import framework.

- [ ] **Step 7: Kiểm tra service từ chối khởi động khi thiếu cấu hình**

Run: `corepack pnpm --filter @billing/payment-service start`
Expected: tiến trình thoát với mã `1` và log JSON `invalid configuration, refusing to start` liệt kê đủ `PAYMENT_DB_HOST ... is required`, `WEBHOOK_URL is required`, `WEBHOOK_SECRET is required`.

- [ ] **Step 8: Commit**

```bash
git add services/payment
git commit -m "feat(payment): add HTTP routes, error mapping and composition root"
```

---

### Task 13: Test đầu-cuối trên service thật

**Files:**
- Test: `services/payment/src/service.integration.test.ts`

**Interfaces:**
- Consumes: `startService`, `RunningService` (Task 12); `PaymentConfig` (Task 11); `WebhookReceiver`, `waitFor`, `createTestDatabase` (Task 2); `verifyWebhook`, `validateChargeWebhook` (Task 3).
- Produces: bằng chứng đầu-cuối cho các hành vi trong spec §2–§6 và §8 (restart).

- [ ] **Step 1: Viết test**

`services/payment/src/service.integration.test.ts`:
```ts
import { createDatabase, migrate } from '@billing/database';
import { validateChargeWebhook, verifyWebhook } from '@billing/contracts';
import { WebhookReceiver, createTestDatabase, waitFor, type TestDatabase } from '@billing/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { paymentMigrations } from '../../../db/payment/migrations.js';
import { startService, type RunningService } from './bootstrap.js';
import type { PaymentConfig } from './config.js';

const secret = 'whsec_e2e';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let testDb: TestDatabase;
let receiver: WebhookReceiver;
const running: RunningService[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase('service');
  const db = createDatabase<unknown>(testDb.config);
  await migrate(db, paymentMigrations);
  await db.destroy();
});
afterAll(async () => {
  await testDb.drop();
});
beforeEach(async () => {
  receiver = await WebhookReceiver.start();
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await receiver.close();
});

function configFor(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return {
    port: 0,
    database: testDb.config,
    webhook: { url: receiver.url, secret, backoffSeconds: [1] },
    workerIntervalMs: 20,
    responseTimeoutMs: 150,
    ...overrides,
  };
}

async function start(overrides: Partial<PaymentConfig> = {}): Promise<RunningService> {
  const service = await startService(configFor(overrides));
  running.push(service);
  return service;
}

function post(
  service: RunningService,
  key: string,
  payload: object,
  headers: Record<string, string> = {},
) {
  return service.app.inject({
    method: 'POST',
    url: '/charges',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...headers },
    payload: JSON.stringify(payload),
  });
}

const body = (reference: string) => ({ amount: 150000, currency: 'VND', reference });
const today = () => new Date().toISOString().slice(0, 10);

describe('payment service, end to end', () => {
  it('accepts a charge, completes it in the background and delivers a signed webhook', async () => {
    const service = await start();
    const res = await post(service, 'e2e-ok', body('topup-ok'));
    expect(res.statusCode).toBe(202);
    const { chargeId } = res.json();
    expect(res.json().status).toBe('PENDING');

    await waitFor(() => receiver.received.length >= 1);
    const [request] = receiver.received;
    expect(
      verifyWebhook({
        secret,
        body: request?.body ?? '',
        header: request?.headers['x-signature'] as string,
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toEqual({ ok: true });
    const parsed = validateChargeWebhook(JSON.parse(request?.body ?? ''));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.payload).toMatchObject({
      type: 'charge.succeeded',
      data: { chargeId, reference: 'topup-ok', amount: 150000, currency: 'VND', status: 'SUCCEEDED' },
    });

    const charge = await service.app.inject({ method: 'GET', url: `/charges/${chargeId}` });
    expect(charge.json()).toMatchObject({ chargeId, status: 'SUCCEEDED' });

    const settlement = await service.app.inject({ method: 'GET', url: `/settlements?date=${today()}` });
    expect(settlement.statusCode).toBe(200);
    expect(settlement.json().items).toContainEqual(expect.objectContaining({ chargeId, status: 'SUCCEEDED' }));
    expect(settlement.json().totals).toContainEqual(
      expect.objectContaining({ currency: 'VND', status: 'SUCCEEDED' }),
    );
  });

  it('reports a declined card through charge.failed', async () => {
    const service = await start();
    const res = await post(service, 'e2e-fail', body('topup-fail'), { 'x-simulate': 'fail=card_declined' });
    await waitFor(() => receiver.received.length >= 1);
    const payload = JSON.parse(receiver.received[0]?.body ?? '');
    expect(payload).toMatchObject({
      type: 'charge.failed',
      data: { chargeId: res.json().chargeId, status: 'FAILED', failureCode: 'card_declined' },
    });
  });

  it('completes a webhook=drop charge but never sends a webhook (the lost-webhook case)', async () => {
    const service = await start();
    const res = await post(service, 'e2e-drop', body('topup-drop'), { 'x-simulate': 'webhook=drop' });
    await waitFor(async () => {
      const charge = await service.app.inject({ method: 'GET', url: `/charges/${res.json().chargeId}` });
      return charge.json().status === 'SUCCEEDED';
    });
    await sleep(200);
    expect(receiver.received).toHaveLength(0);
  });

  it('retries a failing receiver after the backoff', async () => {
    receiver.respondWith(500);
    const service = await start();
    await post(service, 'e2e-retry', body('topup-retry'));
    await waitFor(() => receiver.received.length >= 2, { timeoutMs: 8000 });
    expect(receiver.received[0]?.body).toBe(receiver.received[1]?.body);
  });

  it('holds the first response of response=timeout but answers the replay immediately', async () => {
    const service = await start();
    const startedFirst = Date.now();
    const first = await post(service, 'e2e-timeout', body('topup-timeout'), {
      'x-simulate': 'response=timeout',
    });
    const firstMs = Date.now() - startedFirst;

    const startedReplay = Date.now();
    const replay = await post(service, 'e2e-timeout', body('topup-timeout'), {
      'x-simulate': 'response=timeout',
    });
    const replayMs = Date.now() - startedReplay;

    expect(first.statusCode).toBe(202);
    expect(firstMs).toBeGreaterThanOrEqual(130);
    expect(replay.json()).toEqual(first.json());
    expect(replayMs).toBeLessThan(firstMs);
  });

  it('answers 422 when a key is reused with different content', async () => {
    const service = await start();
    await post(service, 'e2e-reuse', body('a'));
    const conflict = await post(service, 'e2e-reuse', body('b'));
    expect(conflict.statusCode).toBe(422);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keeps its state across a restart and still delivers the pending webhook', async () => {
    // Instance A: chu kỳ worker rất dài nên nó nhận charge nhưng không kịp hoàn tất.
    const before = await start({ workerIntervalMs: 60_000 });
    // Tick đầu của worker chạy ngay khi start(); chờ nó xong để nó không nhặt charge sắp tạo.
    await sleep(500);
    const res = await post(before, 'e2e-restart', body('topup-restart'));
    expect(res.statusCode).toBe(202);
    await running.pop()?.stop();
    expect(receiver.received).toHaveLength(0);

    // Instance B dùng cùng database: phải tự hoàn tất charge và gửi webhook.
    await start({ workerIntervalMs: 20 });
    await waitFor(() => receiver.received.length >= 1);
    expect(JSON.parse(receiver.received[0]?.body ?? '')).toMatchObject({
      type: 'charge.succeeded',
      data: { chargeId: res.json().chargeId },
    });
  });
});
```

- [ ] **Step 2: Chạy test**

Run: `corepack pnpm test:integration service.integration`
Expected: PASS (7 test). Nếu ca restart thất bại vì instance A kịp hoàn tất charge, kiểm tra rằng `workerIntervalMs: 60_000` được áp dụng (`startService` truyền vào `Worker`) và tick đầu của `start()` chạy **trước** `POST`.

- [ ] **Step 3: Commit**

```bash
git add services/payment
git commit -m "test(payment): add end-to-end tests for delivery, drop, retry, timeout and restart"
```

---

### Task 14: Tài liệu, CI và đồng bộ spec

**Files:**
- Create: `services/payment/.env.example`, `docs/adr/0005-payment-db-backed-worker.vi.md`
- Modify: `README.md`, `docs/architecture/README.md`, `Jenkinsfile`, `docs/superpowers/specs/2026-10-09-payment-simulator-design.md`

**Interfaces:**
- Consumes: kết quả các task trước.
- Produces: tài liệu vận hành, stage CI chạy integration, spec khớp với hiện thực.

- [ ] **Step 1: Tạo `services/payment/.env.example`**

```
# Kết nối SQL Server (DB billing_payment đã được tạo bởi deploy/compose.billing.yml)
PAYMENT_DB_HOST=
PAYMENT_DB_PORT=1433
PAYMENT_DB_NAME=billing_payment
PAYMENT_DB_USER=billing_payment_app
PAYMENT_DB_PASSWORD=

# Endpoint của wallet nhận webhook và khóa ký HMAC (không có giá trị mặc định)
WEBHOOK_URL=
WEBHOOK_SECRET=

# Tùy chọn (giá trị mặc định ghi bên cạnh)
PORT=3002
WEBHOOK_BACKOFF=1,5,30,120,600
WORKER_INTERVAL_MS=500
RESPONSE_TIMEOUT_MS=30000
```

- [ ] **Step 2: Thêm mục payment vào `README.md`**

Thêm vào cuối `README.md` mục sau (giữ nguyên các mục cũ):
````markdown
## Payment simulator

Cổng thanh toán giả lập. Thiết kế: [`docs/superpowers/specs/2026-10-09-payment-simulator-design.md`](docs/superpowers/specs/2026-10-09-payment-simulator-design.md).

```bash
# 1. Tạo schema (DB billing_payment phải tồn tại; xem deploy/compose.billing.yml)
PAYMENT_DB_HOST=... PAYMENT_DB_NAME=billing_payment PAYMENT_DB_USER=... PAYMENT_DB_PASSWORD=... \
  corepack pnpm db:migrate:payment

# 2. Chạy service (biến môi trường: services/payment/.env.example)
corepack pnpm --filter @billing/payment-service start
```

Gọi thử:

```bash
curl -s -X POST localhost:3002/charges \
  -H 'content-type: application/json' -H 'idempotency-key: demo-1' -H 'x-simulate: fail=card_declined' \
  -d '{"amount":150000,"currency":"VND","reference":"topup-1"}'
```

`X-Simulate`: `fail=<code>`, `delay=<giây>`, `webhook=drop|duplicate`, `response=timeout` (kết hợp bằng dấu phẩy).

### Test

```bash
corepack pnpm test               # unit, không cần Docker
corepack pnpm test:integration   # cần Docker: chạy SQL Server 2022 bằng testcontainers (lần đầu kéo image)
```

Nếu testcontainers báo lỗi khởi động container "reaper" (Ryuk), đặt `TESTCONTAINERS_RYUK_DISABLED=true`.
````

- [ ] **Step 3: Ghi các bẫy SQL Server vào `docs/architecture/README.md`**

Thêm vào cuối `docs/architecture/README.md`:
```markdown
## Truy cập SQL Server (Kysely + tedious)

Các điểm sau đã được kiểm chứng trên SQL Server 2022 và là nguồn gây lỗi âm thầm nếu quên:

- **Ngày giờ:** luôn truyền bằng `dateTime(date)` (`@billing/database`). Truyền `Date` trực tiếp làm mất mili-giây
  vì tedious gửi kiểu `DateTime`. Cột dùng `datetime2(3)`.
- **`bigint` trả về dạng chuỗi:** đọc qua `toSafeInteger`; không bao giờ `Number(x)` trực tiếp cho tiền.
- **Khóa hàng cho worker:** `select top (n) ... with (updlock, readpast, rowlock) ... order by ...` chỉ chia việc đúng
  khi có index hỗ trợ đúng `ORDER BY` (ví dụ `(status, due_at, id)`). Thiếu index thì mọi hàng bị khóa và worker thứ
  hai nhận về rỗng.
- **Vi phạm khóa duy nhất:** nhận biết bằng `isUniqueViolation(error)` (số lỗi 2627/2601).
- **Migration:** `Migrator` nằm ở `kysely/migration`; dùng `migrate(db, migrations)` của `@billing/database`.
- **Từ khóa T-SQL:** tránh đặt tên cột như `key`, `type`, `error`, `at`, `duplicate`.

## Kiểm thử

- `*.test.ts`: unit, không cần Docker (`corepack pnpm test`).
- `*.integration.test.ts`: cần Docker (`corepack pnpm test:integration`). Một container SQL Server dùng chung cho cả
  lượt chạy (`@billing/testing`), mỗi test file tự tạo database riêng bằng `createTestDatabase`.
- Test trong `domain/` và `application/` không import `kysely` hay `infrastructure/` (lint cấm); chúng dùng
  `services/<tên>/src/test-support.ts`.
```

- [ ] **Step 4: Thêm ADR-0005**

`docs/adr/0005-payment-db-backed-worker.vi.md`:
```markdown
# ADR-0005: Payment hoàn tất charge và gửi webhook bằng worker poll DB, có lease

**Trạng thái:** Chấp nhận — 2026-10-09

## Bối cảnh

Payment giả lập phải bền vững qua restart, tái tạo được lỗi giữa chừng (mất webhook, webhook trùng, retry) và
chạy an toàn khi có nhiều instance. `POST /charges` không được chờ kết quả cuối.

## Quyết định

`POST /charges` chỉ ghi charge `PENDING` kèm `due_at`. Một worker poll SQL Server: (1) hoàn tất charge đến hạn và
ghi `webhook_events` trong cùng một transaction; (2) "chiếm" sự kiện bằng cách đẩy `next_attempt_at` thêm một lease,
gửi HTTP ngoài transaction, rồi ghi kết quả. Chọn việc bằng `UPDLOCK, READPAST` trên index
`(status, due_at, id)` / `(status, next_attempt_at, event_id)`.

## Phương án đã loại

- Hẹn giờ trong bộ nhớ (`setTimeout`): mất khi restart, không kiểm tra được kịch bản "restart giữa chừng".
- Gửi webhook ngay trong transaction hoàn tất: giữ khóa DB trong lúc chờ mạng, và mất sự kiện nếu gửi thất bại.

## Hệ quả

Charge hoàn tất trễ tối đa một chu kỳ worker (mặc định 500 ms). Retry gồm lần gửi đầu cộng tối đa
`len(WEBHOOK_BACKOFF)` lần thử lại. Nếu tiến trình chết khi đang gửi, sự kiện tự đến hạn lại sau lease (60 giây) và có
thể được gửi lặp; người nhận phải khử trùng theo `eventId`.
```

- [ ] **Step 5: Thêm stage Integration vào `Jenkinsfile`**

Trong `Jenkinsfile`, ngay sau stage `'Test'` và trước stage `'SonarQube'`, thêm:
```groovy
        stage('Integration tests') {
            steps {
                // Cần Docker daemon: testcontainers khởi động SQL Server 2022.
                sh 'corepack pnpm test:integration'
            }
        }
```

- [ ] **Step 6: Đồng bộ spec với hiện thực**

Trong `docs/superpowers/specs/2026-10-09-payment-simulator-design.md` thực hiện bốn chỉnh sửa (mỗi cái là một lần thay chuỗi duy nhất):

1. Thay `được retry theo backoff \`WEBHOOK_BACKOFF\` (mặc định \`1,5,30,120,600\` giây), tối đa 5 lần. Hết lượt thì` bằng `được retry theo backoff \`WEBHOOK_BACKOFF\` (mặc định \`1,5,30,120,600\` giây): gửi lần đầu ngay khi charge hoàn tất, sau đó tối đa 5 lần retry (tổng tối đa 6 lần gửi). Hết lượt thì`.
2. Thay dòng `- **\`webhook_attempts\`**: \`event_id\`, \`attempt_no\`, \`at\`, \`status_code\`, \`error\`.` bằng cùng dòng đó cộng thêm hai dòng:
   ```
   
   Tên cột trong code tránh từ khóa T-SQL nên khác một chút so với danh sách trên: `idempotency_keys.idempotency_key`, `webhook_events.event_type`, `webhook_events.send_twice`, `webhook_attempts.attempted_at`, `webhook_attempts.error_message`.
   ```
3. Xóa dòng `| \`WEBHOOK_TOLERANCE_SECONDS\` | Dung sai thời gian khi kiểm chữ ký | \`300\` |` khỏi bảng cấu hình ở mục 7.
4. Thay `Thiếu biến bắt buộc thì service từ chối khởi động.` bằng `\`PAYMENT_DB_PORT\` mặc định \`1433\`. Dung sai thời gian khi kiểm chữ ký là tham số phía nhận (\`verifyWebhook\`, mặc định 300 giây, trong \`@billing/contracts\`) nên payment không có biến này. Sự kiện đang được gửi được "chiếm" bằng lease 60 giây để không gửi trùng giữa hai worker; nếu tiến trình chết, sự kiện tự đến hạn lại sau lease (xem ADR-0005).\n\nThiếu biến bắt buộc thì service từ chối khởi động.`

Sau khi sửa, `grep -n "WEBHOOK_TOLERANCE" docs/superpowers/specs/2026-10-09-payment-simulator-design.md` chỉ còn đúng phần giải thích ở bước 4 (không còn dòng trong bảng).

- [ ] **Step 7: Kiểm tra định dạng và commit**

Run: `corepack pnpm format:check`
Expected: có thể báo lệch ở các file `.ts`/`.json`/`.yml` mới viết (docs/ nằm trong `.prettierignore`). Nếu có, chạy `corepack pnpm exec prettier --write packages services db vitest.config.ts vitest.integration.config.ts package.json`, đọc `git diff --stat` để chắc chỉ là định dạng, rồi chạy lại toàn bộ kiểm tra ở Task 15.

```bash
git add README.md docs services Jenkinsfile packages db
git commit -m "docs(payment): document payment simulator, SQL Server pitfalls, ADR-0005 and CI stage"
```

---

### Task 15: Kiểm chứng toàn bộ và hoàn tất nhánh

**Files:** không tạo file mới (trừ commit định dạng nếu cần).

- [ ] **Step 1: Chạy sạch từ đầu như CI**

```bash
rm -rf node_modules packages/*/node_modules services/*/node_modules coverage
corepack pnpm install --frozen-lockfile
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check
corepack pnpm test:coverage
corepack pnpm test:integration
```
Expected: tất cả exit 0. Unit test: toàn bộ (cũ + mới). Integration: `database`, `migrations`, `repositories`, `create-charge`, `complete-due-charges`, `deliver-due-webhooks`, `get-charge`, `get-settlement`, `service` đều đạt. Nếu `format:check` lệch, chạy `prettier --write` đúng các file bị báo, xem diff, commit `style: apply prettier`.

- [ ] **Step 2: Đối chiếu tiêu chí hoàn thành của bước 2 với spec**

Xác nhận từng mục có bằng chứng (test hoặc lệnh vừa chạy):
- Idempotency: trùng nội dung → replay; khác nội dung → `422`; hai request đồng thời → 1 charge (`create-charge.integration`).
- Kịch bản `fail`, `delay`, `webhook=drop`, `webhook=duplicate`, `response=timeout` (scenario unit, `complete-due-charges`, `deliver-due-webhooks`, `service.integration`).
- Webhook ký HMAC, retry theo backoff, hết lượt thì `FAILED` và giữ lại, lease khi crash (`deliver-due-webhooks.integration`).
- Sao kê theo `completed_at` UTC gồm cả `FAILED`, phân trang cursor, tổng kiểm toàn ngày (`get-settlement.integration`).
- Bền vững qua restart (`service.integration`: ca restart).
- Từ chối khởi động khi thiếu cấu hình (Task 12 Step 7).
- Lint ép ranh giới bốn lớp cho code mới (`corepack pnpm lint`).

- [ ] **Step 3: Hoàn tất nhánh**

REQUIRED SUB-SKILL: dùng superpowers:finishing-a-development-branch để chọn cách tích hợp `feature/payment-simulator` (nhánh này chứa cả commit spec) vào `main`.

