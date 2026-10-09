# Billing Framework — Nền tảng repo (Bước 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng khung monorepo `billing-framework` chạy được end-to-end: toolchain, 3 package dùng chung (`money`, `contracts`, `observability`), lint ép ranh giới kiến trúc, 2 service skeleton (payment/Fastify, wallet/NestJS) có health + correlation id, compose overlay nối hạ tầng ecommerce, Jenkinsfile, ADR.

**Architecture:** pnpm workspaces; mọi package/service là TypeScript ESM, nhập nguồn `.ts` trực tiếp (không bước build ở giai đoạn này). Mỗi service chia 4 lớp `domain/application/infrastructure/interface`; ranh giới được ESLint (`no-restricted-imports`) ép và có test tự động. Giao tiếp với ecommerce chỉ qua `packages/contracts` (JSON Schema).

**Tech Stack:** Node 22, TypeScript strict (NodeNext), pnpm (qua `corepack`), Vitest, ESLint 9 flat config + typescript-eslint, Prettier, Ajv 2020 + json-schema-to-ts, pino, Fastify, NestJS (nền Fastify), Docker Compose, Jenkins.

## Global Constraints

Sao chép nguyên văn từ spec `docs/superpowers/specs/2026-10-09-billing-framework-design.md`:

- Monorepo pnpm workspaces, chạy qua `corepack pnpm`, TypeScript strict.
- Wallet dùng NestJS; payment dùng Fastify.
- Truy cập dữ liệu: Kysely trên SQL Server (chưa dùng ở bước này; không thêm ORM khác).
- Tiền: số nguyên minor unit + currency, **không dùng float**.
- Mỗi service có 4 lớp: `domain` (thuần, không import hạ tầng), `application`, `infrastructure`, `interface`.
- Lint rule cấm `domain` import `infrastructure`; cấm service này import code service kia; giao tiếp giữa service chỉ qua `contracts`.
- Envelope JSON thuần: `messageId`, `type` (version trong tên, ví dụ `billing.order-paid.v1`), `occurredAt`, `correlationId`, `causationId`, `tenantId`, `data`. Người nhận theo "tolerant reader".
- Vhost RabbitMQ riêng `billing`; user riêng cho từng service; DB và user SQL riêng cho từng service.
- Không có tham chiếu đường dẫn tới repo ecommerce; hạ tầng ecommerce được nối bằng biến môi trường.
- `correlationId` xuyên suốt.

## Phạm vi và những gì cố ý hoãn (YAGNI)

Spec mục 8 liệt kê `messaging`, `outbox`, `idempotency`, `testing` là package dùng chung. Các package này **chưa có người dùng** ở bước 1 nên **không tạo ở đây**; mỗi cái được tạo ở bước đầu tiên cần nó: `idempotency` + `outbox` + `testing` ở Wallet core (bước 3), `messaging` ở Tích hợp order (bước 4). Kubernetes manifest và Dockerfile của service cũng hoãn đến khi có image đầu tiên. Pact để bước 4.

## File Structure

```
billing-framework/
├─ package.json                      # root: scripts, devDependencies, packageManager
├─ pnpm-workspace.yaml
├─ tsconfig.base.json                # strict + NodeNext
├─ tsconfig.json                     # typecheck toàn repo (noEmit)
├─ vitest.config.ts                  # chạy mọi *.test.ts
├─ eslint.config.js                  # lint cơ bản + ép ranh giới lớp/service
├─ .prettierrc.json  .prettierignore  .gitignore  .nvmrc  .editorconfig
├─ sonar-project.properties
├─ Jenkinsfile
├─ tools/boundaries.test.ts          # test cấu hình ESLint ép ranh giới
├─ packages/
│  ├─ money/        src/{index,money,errors}.ts  src/money.test.ts
│  ├─ contracts/    src/{index,envelope,events,validate,emit}.ts  scripts/emit-schemas.ts  src/*.test.ts
│  └─ observability/ src/{index,correlation,logger}.ts  src/*.test.ts
├─ services/
│  ├─ payment/      src/main.ts  src/interface/http/{app,health.route}.ts  src/interface/http/app.test.ts
│  └─ wallet/       src/{main,app.module}.ts  src/interface/http/{health.controller,correlation.middleware}.ts  + tests
├─ deploy/
│  ├─ compose.billing.yml
│  ├─ .env.example
│  ├─ sql/init.sql
│  └─ scripts/init-rabbitmq.sh
└─ docs/{adr/*.vi.md, architecture/README.md}  README.md
```

Mỗi package/service: `package.json` (name `@billing/<tên>`, `private`, `type: module`, `exports: ./src/index.ts`).

Quy ước chạy lệnh: mọi lệnh chạy từ gốc repo `C:\Users\ngantran\source\repos\billing-framework`, dùng `corepack pnpm ...` (pnpm không có sẵn trên PATH).

---

### Task 1: Workspace root và toolchain

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`, `.prettierrc.json`, `.prettierignore`, `.gitignore`, `.nvmrc`, `.editorconfig`

**Interfaces:**
- Produces: script `test` (vitest), `lint` (eslint), `typecheck` (tsc), `format:check` (prettier); alias import `@billing/*` qua workspace.

- [ ] **Step 1: Tạo nhánh làm việc**

```bash
git switch -c feature/foundation
```

- [ ] **Step 2: Tạo file cấu hình tĩnh**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "services/*"
  - "packages/*"
```

`.nvmrc`:
```
22
```

`.gitignore`:
```
node_modules/
dist/
coverage/
.env
*.log
.DS_Store
```

`.editorconfig`:
```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
```

`.prettierrc.json`:
```json
{ "singleQuote": true, "trailingComma": "all", "printWidth": 100 }
```

`.prettierignore` (lockfile do pnpm sinh ra; docs/ là văn bản tiếng Việt viết tay, không ép định dạng):
```
pnpm-lock.yaml
docs/
coverage/
dist/
*.sql
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "types": ["node"]
  }
}
```

`tsconfig.json`:
```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["**/*.ts"],
  "exclude": ["**/node_modules", "**/dist", "coverage"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'services/*/src/**'],
      exclude: ['**/*.test.ts', '**/main.ts'],
    },
  },
});
```

`eslint.config.js` (bản cơ bản; Task 5 bổ sung luật ranh giới):
```js
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
];
```

- [ ] **Step 3: Tạo `package.json` gốc**

```json
{
  "name": "billing-framework",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "format:check": "prettier --check ."
  }
}
```

- [ ] **Step 4: Ghim phiên bản pnpm và cài devDependencies**

```bash
corepack enable
corepack use pnpm@latest
corepack pnpm add -D -w typescript vitest @vitest/coverage-v8 tsx eslint typescript-eslint prettier @types/node
```
Expected: `package.json` có trường `packageManager`, tạo `pnpm-lock.yaml`, không lỗi.

- [ ] **Step 5: Kiểm tra toolchain chạy được (chưa có test/code nên chỉ kiểm tra không lỗi cấu hình)**

```bash
corepack pnpm exec vitest run --passWithNoTests
corepack pnpm lint
corepack pnpm typecheck
```
Expected: vitest "No test files found" và exit 0; eslint exit 0; tsc exit 0 (file `vitest.config.ts` nằm trong `include`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm workspace and toolchain"
```

---

### Task 2: `@billing/money`

**Files:**
- Create: `packages/money/package.json`, `packages/money/src/index.ts`, `packages/money/src/errors.ts`, `packages/money/src/money.ts`
- Test: `packages/money/src/money.test.ts`

**Interfaces:**
- Produces:
  - `type Currency = 'VND' | 'USD'`, `const CURRENCIES: readonly Currency[]`
  - `class Money { readonly amount: number; readonly currency: Currency; static of(amount: number, currency: Currency): Money; static zero(currency: Currency): Money; static fromJSON(value: unknown): Money; add(o: Money): Money; subtract(o: Money): Money; negate(): Money; isZero(): boolean; isPositive(): boolean; isNegative(): boolean; equals(o: Money): boolean; compare(o: Money): -1 | 0 | 1; toJSON(): { amount: number; currency: Currency } }`
  - `class InvalidMoneyError extends Error`, `class CurrencyMismatchError extends Error`
- `amount` là số nguyên **minor unit** (VND: đồng; USD: cent), luôn là safe integer; `-0` được chuẩn hóa thành `0`.

- [ ] **Step 1: Tạo `package.json`**

`packages/money/package.json`:
```json
{
  "name": "@billing/money",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

- [ ] **Step 2: Viết test thất bại**

`packages/money/src/money.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './index.js';

describe('Money.of', () => {
  it.each([10.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects non-safe-integer amount %s',
    (amount) => {
      expect(() => Money.of(amount, 'VND')).toThrow(InvalidMoneyError);
    },
  );

  it('rejects an unsupported currency', () => {
    expect(() => Money.of(1, 'EUR' as never)).toThrow(InvalidMoneyError);
  });

  it('normalises negative zero to zero', () => {
    expect(Object.is(Money.of(-0, 'VND').amount, 0)).toBe(true);
  });
});

describe('Money arithmetic', () => {
  it('adds and subtracts in the same currency', () => {
    const a = Money.of(1000, 'VND');
    const b = Money.of(250, 'VND');
    expect(a.add(b).amount).toBe(1250);
    expect(a.subtract(b).amount).toBe(750);
    expect(b.subtract(a).amount).toBe(-750);
  });

  it('throws on currency mismatch', () => {
    expect(() => Money.of(1, 'VND').add(Money.of(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => Money.of(1, 'VND').subtract(Money.of(1, 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => Money.of(1, 'VND').compare(Money.of(1, 'USD'))).toThrow(CurrencyMismatchError);
  });

  it('throws instead of silently losing precision on overflow', () => {
    const max = Money.of(Number.MAX_SAFE_INTEGER, 'VND');
    expect(() => max.add(Money.of(1, 'VND'))).toThrow(InvalidMoneyError);
  });

  it('never accumulates float error', () => {
    // 0.1 + 0.2 style bugs cannot occur because amounts are integers of minor units.
    expect(Money.of(10, 'USD').add(Money.of(20, 'USD')).amount).toBe(30);
  });

  it('negates', () => {
    expect(Money.of(5, 'USD').negate().amount).toBe(-5);
    expect(Money.zero('USD').negate().amount).toBe(0);
  });
});

describe('Money predicates and comparison', () => {
  it('classifies sign', () => {
    expect(Money.zero('VND').isZero()).toBe(true);
    expect(Money.of(1, 'VND').isPositive()).toBe(true);
    expect(Money.of(-1, 'VND').isNegative()).toBe(true);
  });

  it('compares and checks equality', () => {
    expect(Money.of(1, 'VND').compare(Money.of(2, 'VND'))).toBe(-1);
    expect(Money.of(2, 'VND').compare(Money.of(2, 'VND'))).toBe(0);
    expect(Money.of(3, 'VND').compare(Money.of(2, 'VND'))).toBe(1);
    expect(Money.of(2, 'VND').equals(Money.of(2, 'VND'))).toBe(true);
    expect(Money.of(2, 'VND').equals(Money.of(2, 'USD'))).toBe(false);
  });
});

describe('Money JSON', () => {
  it('round-trips', () => {
    const m = Money.of(12345, 'USD');
    expect(JSON.parse(JSON.stringify(m))).toEqual({ amount: 12345, currency: 'USD' });
    expect(Money.fromJSON(JSON.parse(JSON.stringify(m))).equals(m)).toBe(true);
  });

  it.each([null, 'x', {}, { amount: '1', currency: 'VND' }, { amount: 1 }, { amount: 1.5, currency: 'VND' }])(
    'rejects malformed JSON %j',
    (value) => {
      expect(() => Money.fromJSON(value)).toThrow(InvalidMoneyError);
    },
  );
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/money`
Expected: FAIL (không resolve được `./index.js`).

- [ ] **Step 4: Cài code tối thiểu**

`packages/money/src/errors.ts`:
```ts
export class InvalidMoneyError extends Error {
  override name = 'InvalidMoneyError';
}

export class CurrencyMismatchError extends Error {
  override name = 'CurrencyMismatchError';
}
```

`packages/money/src/money.ts`:
```ts
import { CurrencyMismatchError, InvalidMoneyError } from './errors.js';

export type Currency = 'VND' | 'USD';
export const CURRENCIES: readonly Currency[] = ['VND', 'USD'];

export class Money {
  private constructor(
    readonly amount: number,
    readonly currency: Currency,
  ) {}

  static of(amount: number, currency: Currency): Money {
    if (!Number.isSafeInteger(amount)) {
      throw new InvalidMoneyError(`amount must be a safe integer of minor units, got ${amount}`);
    }
    if (!CURRENCIES.includes(currency)) {
      throw new InvalidMoneyError(`unsupported currency ${String(currency)}`);
    }
    return new Money(amount === 0 ? 0 : amount, currency);
  }

  static zero(currency: Currency): Money {
    return Money.of(0, currency);
  }

  static fromJSON(value: unknown): Money {
    if (typeof value !== 'object' || value === null) {
      throw new InvalidMoneyError('money must be an object');
    }
    const { amount, currency } = value as { amount?: unknown; currency?: unknown };
    if (typeof amount !== 'number' || typeof currency !== 'string') {
      throw new InvalidMoneyError('money requires numeric amount and string currency');
    }
    return Money.of(amount, currency as Currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount + other.amount, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount - other.amount, this.currency);
  }

  negate(): Money {
    return Money.of(-this.amount, this.currency);
  }

  isZero(): boolean {
    return this.amount === 0;
  }

  isPositive(): boolean {
    return this.amount > 0;
  }

  isNegative(): boolean {
    return this.amount < 0;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount === other.amount;
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    if (this.amount < other.amount) return -1;
    if (this.amount > other.amount) return 1;
    return 0;
  }

  toJSON(): { amount: number; currency: Currency } {
    return { amount: this.amount, currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }
}
```

`packages/money/src/index.ts`:
```ts
export { CURRENCIES, Money } from './money.js';
export type { Currency } from './money.js';
export { CurrencyMismatchError, InvalidMoneyError } from './errors.js';
```

- [ ] **Step 5: Chạy test để xác nhận đạt, rồi lint + typecheck**

Run: `corepack pnpm exec vitest run packages/money && corepack pnpm lint && corepack pnpm typecheck`
Expected: tất cả PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/money pnpm-lock.yaml
git commit -m "feat(money): add integer minor-unit Money value object"
```

---

### Task 3: `@billing/contracts`

**Files:**
- Create: `packages/contracts/package.json`, `src/index.ts`, `src/envelope.ts`, `src/events.ts`, `src/validate.ts`, `src/emit.ts`, `scripts/emit-schemas.ts`
- Test: `src/validate.test.ts`, `src/emit.test.ts`

**Interfaces:**
- Produces:
  - `envelopeSchema`, `eventSchemas` (map `type → JSON Schema của data`), `EventType = keyof typeof eventSchemas`
  - Kiểu data: `OrderReadyForPaymentV1`, `OrderPaidV1`, `OrderPaymentFailedV1`; `Envelope<TData>`
  - `validateMessage(raw: unknown): ValidationResult` với `ValidationResult = { ok: true; type: EventType; message: Envelope<unknown> } | { ok: false; errors: string[] }`
  - `emitSchemas(dir: string): Promise<string[]>` ghi `envelope.v1.json` và `<type>.json`, trả về danh sách file đã ghi
  - Số tiền trong event: `{ "amount": integer >= 1 (minor unit), "currency": "VND" | "USD" }`
  - `causationId` luôn có mặt; với message gốc (không do message khác sinh ra) đặt bằng chính `messageId`.

- [ ] **Step 1: Tạo package và cài thư viện**

`packages/contracts/package.json`:
```json
{
  "name": "@billing/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "emit": "tsx scripts/emit-schemas.ts dist/schemas" }
}
```

```bash
corepack pnpm --filter @billing/contracts add ajv ajv-formats json-schema-to-ts
```

- [ ] **Step 2: Viết test thất bại cho validate**

`packages/contracts/src/validate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { validateMessage } from './index.js';

const base = {
  messageId: '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01',
  occurredAt: '2026-10-09T10:00:00Z',
  correlationId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
  causationId: '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01',
  tenantId: 'tenant-1',
};

const readyForPayment = {
  ...base,
  type: 'orders.order-ready-for-payment.v1',
  data: { orderId: 'o-1', customerId: 'c-1', amount: 150000, currency: 'VND' },
};

describe('validateMessage', () => {
  it('accepts a valid order-ready-for-payment message', () => {
    const result = validateMessage(readyForPayment);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.type).toBe('orders.order-ready-for-payment.v1');
  });

  it('accepts a valid order-paid message', () => {
    const result = validateMessage({
      ...base,
      type: 'billing.order-paid.v1',
      data: { orderId: 'o-1', walletTransactionId: 'tx-1', paidAt: '2026-10-09T10:00:01Z' },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts order-payment-failed with every documented reason', () => {
    for (const reason of ['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT']) {
      const result = validateMessage({
        ...base,
        type: 'billing.order-payment-failed.v1',
        data: { orderId: 'o-1', reason },
      });
      expect(result.ok, reason).toBe(true);
    }
  });

  it('rejects an unknown failure reason', () => {
    const result = validateMessage({
      ...base,
      type: 'billing.order-payment-failed.v1',
      data: { orderId: 'o-1', reason: 'BECAUSE' },
    });
    expect(result.ok).toBe(false);
  });

  it('tolerates unknown extra fields (tolerant reader)', () => {
    const result = validateMessage({
      ...readyForPayment,
      futureEnvelopeField: true,
      data: { ...readyForPayment.data, futureField: 'x' },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['float amount', { amount: 10.5 }],
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -1 }],
    ['string amount', { amount: '100' }],
    ['unsupported currency', { currency: 'EUR' }],
    ['missing orderId', { orderId: undefined }],
  ])('rejects %s', (_name, patch) => {
    const result = validateMessage({
      ...readyForPayment,
      data: { ...readyForPayment.data, ...patch },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown message type', () => {
    const result = validateMessage({ ...base, type: 'orders.something-else.v1', data: {} });
    expect(result).toEqual({ ok: false, errors: [expect.stringContaining('UNKNOWN_TYPE')] });
  });

  it.each([
    ['non-uuid messageId', { messageId: 'abc' }],
    ['bad timestamp', { occurredAt: 'yesterday' }],
    ['missing tenantId', { tenantId: undefined }],
    ['missing causationId', { causationId: undefined }],
    ['type without version', { type: 'orders.order-ready-for-payment' }],
  ])('rejects envelope with %s', (_name, patch) => {
    const result = validateMessage({ ...readyForPayment, ...patch });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateMessage(null).ok).toBe(false);
    expect(validateMessage('x').ok).toBe(false);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/contracts`
Expected: FAIL (không resolve được `./index.js`).

- [ ] **Step 4: Cài schema, kiểu và validator**

`packages/contracts/src/envelope.ts`:
```ts
import type { FromSchema } from 'json-schema-to-ts';

export const envelopeSchema = {
  $id: 'urn:billing:schema:envelope:v1',
  type: 'object',
  required: [
    'messageId',
    'type',
    'occurredAt',
    'correlationId',
    'causationId',
    'tenantId',
    'data',
  ],
  properties: {
    messageId: { type: 'string', format: 'uuid' },
    type: { type: 'string', pattern: '^(orders|billing)\\.[a-z][a-z-]*\\.v[0-9]+$' },
    occurredAt: { type: 'string', format: 'date-time' },
    correlationId: { type: 'string', format: 'uuid' },
    causationId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', minLength: 1 },
    data: { type: 'object' },
  },
} as const;

type EnvelopeBase = FromSchema<typeof envelopeSchema>;

export type Envelope<TData = unknown> = Omit<EnvelopeBase, 'data'> & { data: TData };
```

`packages/contracts/src/events.ts`:
```ts
import type { FromSchema } from 'json-schema-to-ts';

const moneyProperties = {
  amount: { type: 'integer', minimum: 1, description: 'Số nguyên minor unit (VND: đồng, USD: cent)' },
  currency: { type: 'string', enum: ['VND', 'USD'] },
} as const;

export const orderReadyForPaymentV1 = {
  $id: 'urn:billing:schema:orders.order-ready-for-payment:v1',
  type: 'object',
  required: ['orderId', 'customerId', 'amount', 'currency'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    customerId: { type: 'string', minLength: 1 },
    ...moneyProperties,
  },
} as const;

export const orderPaidV1 = {
  $id: 'urn:billing:schema:billing.order-paid:v1',
  type: 'object',
  required: ['orderId', 'walletTransactionId', 'paidAt'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    walletTransactionId: { type: 'string', minLength: 1 },
    paidAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const orderPaymentFailedV1 = {
  $id: 'urn:billing:schema:billing.order-payment-failed:v1',
  type: 'object',
  required: ['orderId', 'reason'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    reason: {
      type: 'string',
      enum: ['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'],
    },
  },
} as const;

export const eventSchemas = {
  'orders.order-ready-for-payment.v1': orderReadyForPaymentV1,
  'billing.order-paid.v1': orderPaidV1,
  'billing.order-payment-failed.v1': orderPaymentFailedV1,
} as const;

export type EventType = keyof typeof eventSchemas;

export type OrderReadyForPaymentV1 = FromSchema<typeof orderReadyForPaymentV1>;
export type OrderPaidV1 = FromSchema<typeof orderPaidV1>;
export type OrderPaymentFailedV1 = FromSchema<typeof orderPaymentFailedV1>;
```

`packages/contracts/src/validate.ts`:
```ts
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { envelopeSchema, type Envelope } from './envelope.js';
import { eventSchemas, type EventType } from './events.js';

// ajv và ajv-formats là CJS; tùy bundler/runtime mà default import là hàm hoặc { default }.
const unwrap = <T>(mod: T | { default: T }): T =>
  typeof mod === 'function' ? mod : (mod as { default: T }).default;

const Ajv2020 = unwrap(Ajv2020Module);
const addFormats = unwrap(addFormatsModule);

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

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
  const message = raw as Envelope<unknown>;
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

`packages/contracts/src/index.ts`:
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
export { emitSchemas } from './emit.js';
```

`packages/contracts/src/emit.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { envelopeSchema } from './envelope.js';
import { eventSchemas } from './events.js';

/** Ghi JSON Schema thành file để team ecommerce (C#) lấy làm hợp đồng. */
export async function emitSchemas(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: Array<[string, unknown]> = [
    ['envelope.v1.json', envelopeSchema],
    ...Object.entries(eventSchemas).map(([type, schema]): [string, unknown] => [`${type}.json`, schema]),
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

`packages/contracts/scripts/emit-schemas.ts`:
```ts
import { emitSchemas } from '../src/emit.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: emit-schemas <output-dir>');
  process.exit(1);
}
const written = await emitSchemas(dir);
console.log(`wrote ${written.length} schema files to ${dir}`);
```

- [ ] **Step 5: Chạy test validate để xác nhận đạt**

Run: `corepack pnpm exec vitest run packages/contracts`
Expected: PASS. Nếu `Ajv2020 is not a constructor`, hàm `unwrap` đang nhận sai dạng module: kiểm tra `typeof Ajv2020Module` và `typeof addFormatsModule` rồi chỉnh `unwrap` — không thêm `as any` rải rác.

- [ ] **Step 6: Viết test cho emit**

`packages/contracts/src/emit.test.ts`:
```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventSchemas } from './events.js';
import { emitSchemas } from './index.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'contracts-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('emitSchemas', () => {
  it('writes the envelope and one file per event type', async () => {
    const written = await emitSchemas(dir);
    expect(written).toHaveLength(1 + Object.keys(eventSchemas).length);
    const paid = JSON.parse(await readFile(join(dir, 'billing.order-paid.v1.json'), 'utf8'));
    expect(paid).toEqual(eventSchemas['billing.order-paid.v1']);
    const envelope = JSON.parse(await readFile(join(dir, 'envelope.v1.json'), 'utf8'));
    expect(envelope.$id).toBe('urn:billing:schema:envelope:v1');
  });
});
```

- [ ] **Step 7: Chạy toàn bộ test, lint, typecheck, và thử lệnh emit**

```bash
corepack pnpm exec vitest run packages/contracts && corepack pnpm lint && corepack pnpm typecheck
corepack pnpm --filter @billing/contracts emit
```
Expected: PASS; lệnh emit in `wrote 4 schema files to dist/schemas`.

- [ ] **Step 8: Commit**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "feat(contracts): add JSON envelope, order event schemas and validator"
```

---

### Task 4: `@billing/observability`

**Files:**
- Create: `packages/observability/package.json`, `src/index.ts`, `src/correlation.ts`, `src/logger.ts`
- Test: `src/correlation.test.ts`, `src/logger.test.ts`

**Interfaces:**
- Produces:
  - `CORRELATION_HEADER = 'x-correlation-id'`
  - `runWithCorrelation<T>(correlationId: string, fn: () => T): T`
  - `getCorrelationId(): string | undefined`
  - `resolveCorrelationId(incoming: string | string[] | undefined): string` — dùng giá trị đầu vào nếu là UUID hợp lệ, ngược lại sinh `crypto.randomUUID()`
  - `createLogger(service: string, destination?: NodeJS.WritableStream): pino.Logger` — mỗi dòng log JSON có `service` và `correlationId` (nếu đang trong ngữ cảnh)

- [ ] **Step 1: Tạo package, cài pino**

`packages/observability/package.json`:
```json
{
  "name": "@billing/observability",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```
```bash
corepack pnpm --filter @billing/observability add pino
```

- [ ] **Step 2: Viết test thất bại**

`packages/observability/src/correlation.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { getCorrelationId, resolveCorrelationId, runWithCorrelation } from './index.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('correlation context', () => {
  it('is undefined outside a context', () => {
    expect(getCorrelationId()).toBeUndefined();
  });

  it('propagates across awaits inside a context', async () => {
    const seen = await runWithCorrelation('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getCorrelationId();
    });
    expect(seen).toBe('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02');
  });

  it('keeps concurrent contexts isolated', async () => {
    const run = (id: string) =>
      runWithCorrelation(id, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5));
        return getCorrelationId();
      });
    const a = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const b = '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01';
    expect(await Promise.all([run(a), run(b)])).toEqual([a, b]);
  });
});

describe('resolveCorrelationId', () => {
  it('reuses a valid incoming uuid', () => {
    expect(resolveCorrelationId('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02')).toBe(
      '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
    );
  });

  it.each([undefined, '', 'not-a-uuid', ['3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02', 'x']])(
    'generates a fresh uuid for %j',
    (incoming) => {
      expect(resolveCorrelationId(incoming as string | undefined)).toMatch(UUID);
    },
  );
});
```

`packages/observability/src/logger.test.ts`:
```ts
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, runWithCorrelation } from './index.js';

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()));
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('stamps service name and the active correlation id', () => {
    const { lines, stream } = capture();
    const log = createLogger('wallet', stream);
    runWithCorrelation('3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02', () => log.info('hello'));
    expect(lines[0]).toMatchObject({
      service: 'wallet',
      msg: 'hello',
      correlationId: '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02',
    });
  });

  it('omits correlationId when there is no context', () => {
    const { lines, stream } = capture();
    createLogger('payment', stream).info('boot');
    expect(lines[0]).not.toHaveProperty('correlationId');
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run packages/observability`
Expected: FAIL (không resolve được `./index.js`).

- [ ] **Step 4: Cài code tối thiểu**

`packages/observability/src/correlation.ts`:
```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const storage = new AsyncLocalStorage<string>();

export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  return storage.run(correlationId, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore();
}

export function resolveCorrelationId(incoming: string | string[] | undefined): string {
  return typeof incoming === 'string' && UUID.test(incoming) ? incoming : randomUUID();
}
```

`packages/observability/src/logger.ts`:
```ts
import pino from 'pino';
import { getCorrelationId } from './correlation.js';

export function createLogger(service: string, destination?: NodeJS.WritableStream): pino.Logger {
  const options: pino.LoggerOptions = {
    base: { service },
    mixin: () => {
      const correlationId = getCorrelationId();
      return correlationId ? { correlationId } : {};
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
```

`packages/observability/src/index.ts`:
```ts
export {
  CORRELATION_HEADER,
  getCorrelationId,
  resolveCorrelationId,
  runWithCorrelation,
} from './correlation.js';
export { createLogger } from './logger.js';
```

- [ ] **Step 5: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run packages/observability && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/observability pnpm-lock.yaml
git commit -m "feat(observability): add correlation context and structured logger"
```

---

### Task 5: Ép ranh giới kiến trúc bằng ESLint

**Files:**
- Modify: `eslint.config.js`
- Test: `tools/boundaries.test.ts`

**Interfaces:**
- Consumes: quy tắc từ Global Constraints (domain thuần, cấm import chéo service).
- Produces: cấu hình lint mà mọi service sau này tuân theo. Quy tắc theo lớp trong `services/<svc>/src/<lớp>/**`:
  - `domain`: cấm import `application|infrastructure|interface`, cấm framework/hạ tầng (`@nestjs/*`, `fastify`, `kysely`, `mssql`, `tedious`, `amqplib`, `pino`), cấm mọi `@billing/*` trừ `@billing/money`.
  - `application`: cấm `infrastructure|interface` và framework/hạ tầng.
  - `infrastructure`: cấm `interface`.
  - `interface`: cấm `infrastructure` (nối dây ở composition root `src/main.ts`/`src/app.module.ts`).
  - Mọi file trong service: cấm import code của service kia (`**/<kia>/src/**`, `@billing/<kia>-service`).

- [ ] **Step 1: Viết test thất bại**

`tools/boundaries.test.ts`:
```ts
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function violations(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return (result?.messages ?? [])
    .filter((m) => m.ruleId === 'no-restricted-imports')
    .map((m) => m.message);
}

describe('architecture boundaries', () => {
  it('forbids domain from importing infrastructure', async () => {
    const v = await violations(
      'services/wallet/src/domain/wallet.ts',
      "import { db } from '../infrastructure/db.js';\nexport const x = db;\n",
    );
    expect(v).toHaveLength(1);
  });

  it('forbids domain from importing frameworks and drivers', async () => {
    for (const lib of ['kysely', 'fastify', '@nestjs/common', 'amqplib', 'pino']) {
      const v = await violations(
        'services/wallet/src/domain/wallet.ts',
        `import x from '${lib}';\nexport const y = x;\n`,
      );
      expect(v, lib).toHaveLength(1);
    }
  });

  it('forbids domain from importing shared packages other than money', async () => {
    const bad = await violations(
      'services/wallet/src/domain/wallet.ts',
      "import { validateMessage } from '@billing/contracts';\nexport const y = validateMessage;\n",
    );
    expect(bad).toHaveLength(1);
    const ok = await violations(
      'services/wallet/src/domain/wallet.ts',
      "import { Money } from '@billing/money';\nexport const y = Money;\n",
    );
    expect(ok).toHaveLength(0);
  });

  it('forbids application from importing infrastructure, interface and frameworks', async () => {
    for (const spec of ['../infrastructure/db.js', '../interface/http/app.js', 'fastify']) {
      const v = await violations(
        'services/payment/src/application/charge.ts',
        `import x from '${spec}';\nexport const y = x;\n`,
      );
      expect(v, spec).toHaveLength(1);
    }
  });

  it('forbids interface from importing infrastructure', async () => {
    const v = await violations(
      'services/payment/src/interface/http/app.ts',
      "import { db } from '../../infrastructure/db.js';\nexport const x = db;\n",
    );
    expect(v).toHaveLength(1);
  });

  it('allows infrastructure to import application and domain', async () => {
    const v = await violations(
      'services/wallet/src/infrastructure/repo.ts',
      "import { a } from '../application/a.js';\nimport { d } from '../domain/d.js';\nexport const x = [a, d];\n",
    );
    expect(v).toHaveLength(0);
  });

  it('forbids one service from importing the other, in every layer', async () => {
    const cases: Array<[string, string]> = [
      ['services/wallet/src/application/x.ts', '../../../payment/src/domain/charge.js'],
      ['services/wallet/src/main.ts', '@billing/payment-service'],
      ['services/payment/src/infrastructure/x.ts', '../../../wallet/src/domain/wallet.js'],
      ['services/payment/src/domain/x.ts', '@billing/wallet-service'],
    ];
    for (const [file, spec] of cases) {
      const v = await violations(file, `import x from '${spec}';\nexport const y = x;\n`);
      expect(v, `${file} -> ${spec}`).toHaveLength(1);
    }
  });
});
```

```bash
corepack pnpm exec vitest run tools
```
Expected: FAIL (chưa có luật nào nên `violations` trả về mảng rỗng).

- [ ] **Step 2: Cài luật ranh giới**

Thay toàn bộ `eslint.config.js`:
```js
import tseslint from 'typescript-eslint';

const SERVICES = ['wallet', 'payment'];
const LAYERS = ['domain', 'application', 'infrastructure', 'interface'];

const FRAMEWORKS = [
  '@nestjs/*',
  'fastify',
  'fastify/*',
  'kysely',
  'mssql',
  'tedious',
  'amqplib',
  'pino',
  'pino/*',
];

const layerImport = (layer) => ({
  group: [`**/${layer}/**`, `**/${layer}`],
  message: `Import từ lớp "${layer}" vi phạm hướng phụ thuộc (domain ← application ← infrastructure/interface).`,
});

const FORBIDDEN_BY_LAYER = {
  domain: [
    layerImport('application'),
    layerImport('infrastructure'),
    layerImport('interface'),
    { group: FRAMEWORKS, message: 'domain phải thuần: không import framework hay driver.' },
    {
      group: ['@billing/*', '!@billing/money'],
      message: 'domain chỉ được dùng @billing/money trong số các package dùng chung.',
    },
  ],
  application: [
    layerImport('infrastructure'),
    layerImport('interface'),
    { group: FRAMEWORKS, message: 'application chỉ phụ thuộc port, không phụ thuộc framework hay driver.' },
  ],
  infrastructure: [layerImport('interface')],
  interface: [layerImport('infrastructure')],
};

const otherService = (service) => {
  const other = SERVICES.find((s) => s !== service);
  return {
    group: [`**/${other}/src/**`, `@billing/${other}-service`, `@billing/${other}-service/*`],
    message: `Service "${service}" không được import code của service "${other}"; giao tiếp qua @billing/contracts.`,
  };
};

const restrict = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default [
  { ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  // Cấm import chéo service ở mọi file của service (kể cả composition root).
  ...SERVICES.map((service) => ({
    files: [`services/${service}/src/**/*.ts`],
    rules: restrict([otherService(service)]),
  })),
  // Luật theo lớp; phải lặp lại luật chéo-service vì `no-restricted-imports` bị thay thế, không gộp.
  ...SERVICES.flatMap((service) =>
    LAYERS.map((layer) => ({
      files: [`services/${service}/src/${layer}/**/*.ts`],
      rules: restrict([...FORBIDDEN_BY_LAYER[layer], otherService(service)]),
    })),
  ),
];
```

- [ ] **Step 3: Chạy test để xác nhận đạt**

Run: `corepack pnpm exec vitest run tools && corepack pnpm lint`
Expected: PASS. Nếu một ca "forbids" không bắt được, kiểm tra mẫu `group` (cú pháp gitignore) trước khi nới test.

- [ ] **Step 4: Commit**

```bash
git add eslint.config.js tools
git commit -m "feat(lint): enforce layer and cross-service import boundaries"
```

---

### Task 6: Service `payment` (Fastify skeleton)

**Files:**
- Create: `services/payment/package.json`, `src/main.ts`, `src/interface/http/app.ts`, `src/interface/http/health.route.ts`
- Test: `services/payment/src/interface/http/app.test.ts`

**Interfaces:**
- Consumes: `CORRELATION_HEADER`, `resolveCorrelationId`, `runWithCorrelation`, `createLogger` từ `@billing/observability`.
- Produces: `buildApp(options?: { logger?: pino.Logger }): Promise<FastifyInstance>`; `GET /health` → `200 { "status": "ok", "service": "payment" }`; mọi response có header `x-correlation-id` (tái sử dụng UUID hợp lệ từ request, ngược lại sinh mới).

- [ ] **Step 1: Tạo package và cài thư viện**

`services/payment/package.json`:
```json
{
  "name": "@billing/payment-service",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "tsx watch src/main.ts", "start": "tsx src/main.ts" }
}
```
```bash
corepack pnpm --filter @billing/payment-service add fastify @billing/observability@workspace:*
```

- [ ] **Step 2: Viết test thất bại**

`services/payment/src/interface/http/app.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getCorrelationId } from '@billing/observability';
import { buildApp } from './app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});
afterEach(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('reports ok with the service name', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', service: 'payment' });
  });

  it('generates a correlation id when the caller sends none', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-correlation-id']).toMatch(UUID);
  });

  it('echoes a valid incoming correlation id', async () => {
    const id = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': id },
    });
    expect(res.headers['x-correlation-id']).toBe(id);
  });

  it('makes the correlation id visible to handlers', async () => {
    let seen: string | undefined;
    app.get('/probe', async () => {
      seen = getCorrelationId();
      return {};
    });
    const id = '0b2d6a3e-0c0e-4a52-9a0b-1d9d8a8c1f01';
    await app.inject({ method: 'GET', url: '/probe', headers: { 'x-correlation-id': id } });
    expect(seen).toBe(id);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/payment`
Expected: FAIL (không resolve được `./app.js`).

- [ ] **Step 4: Cài code tối thiểu**

`services/payment/src/interface/http/health.route.ts`:
```ts
import type { FastifyInstance } from 'fastify';

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok', service: 'payment' }));
}
```

`services/payment/src/interface/http/app.ts`:
```ts
import Fastify, { type FastifyInstance } from 'fastify';
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  runWithCorrelation,
} from '@billing/observability';
import { healthRoute } from './health.route.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (request, reply, done) => {
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelation(correlationId, () => done());
  });

  await app.register(healthRoute);
  return app;
}
```

`services/payment/src/main.ts`:
```ts
import { createLogger } from '@billing/observability';
import { buildApp } from './interface/http/app.js';

const log = createLogger('payment');
const port = Number(process.env.PORT ?? 3002);

const app = await buildApp();
await app.listen({ port, host: '0.0.0.0' });
log.info({ port }, 'payment service listening');
```

- [ ] **Step 5: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run services/payment && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS. Nếu test "makes the correlation id visible to handlers" thất bại thì ngữ cảnh không lan qua hook: giữ `done()` bên trong `runWithCorrelation` như trên, không đưa ra ngoài.

- [ ] **Step 6: Kiểm tra chạy thật**

```bash
corepack pnpm --filter @billing/payment-service start &
sleep 3 && curl -si localhost:3002/health
```
Expected: `200`, header `x-correlation-id: <uuid>`, body `{"status":"ok","service":"payment"}`. Dừng tiến trình sau khi kiểm tra.

- [ ] **Step 7: Commit**

```bash
git add services/payment pnpm-lock.yaml
git commit -m "feat(payment): add Fastify service skeleton with health and correlation id"
```

---

### Task 7: Service `wallet` (NestJS skeleton)

**Files:**
- Create: `services/wallet/package.json`, `src/main.ts`, `src/app.module.ts`, `src/interface/http/health.controller.ts`, `src/interface/http/correlation.middleware.ts`
- Test: `services/wallet/src/interface/http/health.controller.test.ts`, `src/interface/http/correlation.middleware.test.ts`

**Interfaces:**
- Consumes: `CORRELATION_HEADER`, `resolveCorrelationId`, `runWithCorrelation`, `createLogger` từ `@billing/observability`.
- Produces: `HealthController.check(): { status: 'ok'; service: 'wallet' }` ở `GET /health`; `CorrelationMiddleware.use(req, res, next)` đặt header `x-correlation-id` và chạy `next` trong ngữ cảnh correlation; `AppModule`.
- **Quy ước bắt buộc cho wallet:** luôn tiêm phụ thuộc bằng `@Inject(TOKEN)` tường minh, không dựa vào metadata kiểu tham số (`emitDecoratorMetadata` không được esbuild/tsx hỗ trợ). Ghi quy ước này vào `docs/architecture/README.md` ở Task 10.

- [ ] **Step 1: Tạo package và cài thư viện**

`services/wallet/package.json`:
```json
{
  "name": "@billing/wallet-service",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "tsx watch src/main.ts", "start": "tsx src/main.ts" }
}
```
```bash
corepack pnpm --filter @billing/wallet-service add @nestjs/common @nestjs/core @nestjs/platform-fastify reflect-metadata rxjs @billing/observability@workspace:*
```

- [ ] **Step 2: Viết test thất bại**

`services/wallet/src/interface/http/health.controller.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports ok with the service name', () => {
    expect(new HealthController().check()).toEqual({ status: 'ok', service: 'wallet' });
  });
});
```

`services/wallet/src/interface/http/correlation.middleware.test.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { getCorrelationId } from '@billing/observability';
import { CorrelationMiddleware } from './correlation.middleware.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(headers: Record<string, string>) {
  const set: Record<string, string> = {};
  const res = { setHeader: (k: string, v: string) => (set[k] = v) } as unknown as ServerResponse;
  let seen: string | undefined;
  new CorrelationMiddleware().use({ headers } as IncomingMessage, res, () => {
    seen = getCorrelationId();
  });
  return { header: set['x-correlation-id'], seen };
}

describe('CorrelationMiddleware', () => {
  it('generates an id, sets the header and exposes it to downstream code', () => {
    const { header, seen } = run({});
    expect(header).toMatch(UUID);
    expect(seen).toBe(header);
  });

  it('reuses a valid incoming id', () => {
    const id = '3f1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c02';
    const { header, seen } = run({ 'x-correlation-id': id });
    expect(header).toBe(id);
    expect(seen).toBe(id);
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận thất bại**

Run: `corepack pnpm exec vitest run services/wallet`
Expected: FAIL (không resolve được module).

- [ ] **Step 4: Cài code tối thiểu**

`services/wallet/src/interface/http/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: 'wallet' } {
    return { status: 'ok', service: 'wallet' };
  }
}
```

`services/wallet/src/interface/http/correlation.middleware.ts`:
```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  runWithCorrelation,
} from '@billing/observability';

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: IncomingMessage, res: ServerResponse, next: () => void): void {
    const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithCorrelation(correlationId, next);
  }
}
```

`services/wallet/src/app.module.ts`:
```ts
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CorrelationMiddleware } from './interface/http/correlation.middleware.js';
import { HealthController } from './interface/http/health.controller.js';

@Module({ controllers: [HealthController] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
```

`services/wallet/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger } from '@billing/observability';
import { AppModule } from './app.module.js';

const log = createLogger('wallet');
const port = Number(process.env.PORT ?? 3001);

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await app.listen(port, '0.0.0.0');
log.info({ port }, 'wallet service listening');
```

- [ ] **Step 5: Chạy test, lint, typecheck**

Run: `corepack pnpm exec vitest run services/wallet && corepack pnpm lint && corepack pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Kiểm tra chạy thật (rủi ro ESM/CJS của Nest nằm ở đây)**

```bash
corepack pnpm --filter @billing/wallet-service start &
sleep 5 && curl -si localhost:3001/health
```
Expected: `200`, header `x-correlation-id: <uuid>`, body `{"status":"ok","service":"wallet"}`. Nếu Nest không khởi động được do lỗi import ESM/CJS, **dừng và báo lại** với đầy đủ thông báo lỗi thay vì đổi sang CommonJS hay đổi runner; đây là quyết định kiến trúc cần xác nhận. Dừng tiến trình sau khi kiểm tra.

- [ ] **Step 7: Commit**

```bash
git add services/wallet pnpm-lock.yaml
git commit -m "feat(wallet): add NestJS service skeleton with health and correlation id"
```

---

### Task 8: Compose overlay nối hạ tầng ecommerce

**Files:**
- Create: `deploy/compose.billing.yml`, `deploy/.env.example`, `deploy/sql/init.sql`, `deploy/scripts/init-rabbitmq.sh`

**Interfaces:**
- Consumes: SQL Server (`sqlserver`) và RabbitMQ (`rabbitmq`) của stack ecommerce trên network external `${ECOMMERCE_NETWORK}` (mặc định `ecomerce-stack_backbone`, theo `name: ecomerce-stack` và network `backbone` của repo ecommerce).
- Produces: DB `billing_wallet`, `billing_payment` + login/user riêng `billing_wallet_app`, `billing_payment_app`; vhost RabbitMQ `billing` + user `billing_wallet`, `billing_payment` chỉ có quyền trên vhost đó. Cả hai job init **idempotent**.

- [ ] **Step 1: Tạo `deploy/.env.example`**

```
# Network của stack ecommerce (compose project "ecomerce-stack", network "backbone").
ECOMMERCE_NETWORK=ecomerce-stack_backbone

# Hạ tầng dùng chung (tên service trên network trên)
BILLING_SQLSERVER_HOST=sqlserver
BILLING_SQLSERVER_SA_USER=sa
# Đặt trùng MSSQL_SA_PASSWORD của stack ecommerce
BILLING_SQLSERVER_SA_PASSWORD=

BILLING_RABBITMQ_HOST=rabbitmq
BILLING_RABBITMQ_MGMT_PORT=15672
# Đặt trùng RABBITMQ_USER / RABBITMQ_PASSWORD của stack ecommerce
BILLING_RABBITMQ_ADMIN_USER=guest
BILLING_RABBITMQ_ADMIN_PASSWORD=

# Mật khẩu của các tài khoản riêng của billing (đặt giá trị cục bộ, không commit)
BILLING_WALLET_DB_PASSWORD=
BILLING_PAYMENT_DB_PASSWORD=
BILLING_WALLET_MQ_PASSWORD=
BILLING_PAYMENT_MQ_PASSWORD=
```

- [ ] **Step 2: Tạo `deploy/sql/init.sql` (idempotent, biến sqlcmd `$(...)`)**

```sql
-- Chạy bằng sqlcmd với -v WALLET_DB_PASSWORD=... PAYMENT_DB_PASSWORD=...
-- Tạo DB và tài khoản riêng cho từng service; chạy lại nhiều lần không lỗi.

IF DB_ID(N'billing_wallet') IS NULL CREATE DATABASE [billing_wallet];
GO
IF DB_ID(N'billing_payment') IS NULL CREATE DATABASE [billing_payment];
GO

IF SUSER_ID(N'billing_wallet_app') IS NULL
  CREATE LOGIN [billing_wallet_app] WITH PASSWORD = N'$(WALLET_DB_PASSWORD)', CHECK_POLICY = OFF;
GO
IF SUSER_ID(N'billing_payment_app') IS NULL
  CREATE LOGIN [billing_payment_app] WITH PASSWORD = N'$(PAYMENT_DB_PASSWORD)', CHECK_POLICY = OFF;
GO

USE [billing_wallet];
GO
IF USER_ID(N'billing_wallet_app') IS NULL CREATE USER [billing_wallet_app] FOR LOGIN [billing_wallet_app];
GO
ALTER ROLE db_datareader ADD MEMBER [billing_wallet_app];
ALTER ROLE db_datawriter ADD MEMBER [billing_wallet_app];
ALTER ROLE db_ddladmin ADD MEMBER [billing_wallet_app];
GO

USE [billing_payment];
GO
IF USER_ID(N'billing_payment_app') IS NULL CREATE USER [billing_payment_app] FOR LOGIN [billing_payment_app];
GO
ALTER ROLE db_datareader ADD MEMBER [billing_payment_app];
ALTER ROLE db_datawriter ADD MEMBER [billing_payment_app];
ALTER ROLE db_ddladmin ADD MEMBER [billing_payment_app];
GO
```

- [ ] **Step 3: Tạo `deploy/scripts/init-rabbitmq.sh` (POSIX sh, chạy trong image curl)**

```sh
#!/bin/sh
# Tạo vhost "billing" và user riêng qua management API. Idempotent (PUT).
set -eu

base="http://${RABBITMQ_HOST}:${RABBITMQ_MGMT_PORT}/api"
auth="${RABBITMQ_ADMIN_USER}:${RABBITMQ_ADMIN_PASSWORD}"

put() { curl -fsS -u "$auth" -H 'content-type: application/json' -X PUT "$base/$1" -d "$2"; }

put "vhosts/billing" '{}'

for svc in wallet payment; do
  case "$svc" in
    wallet) pass="$WALLET_MQ_PASSWORD" ;;
    payment) pass="$PAYMENT_MQ_PASSWORD" ;;
  esac
  put "users/billing_${svc}" "{\"password\":\"${pass}\",\"tags\":\"\"}"
  put "permissions/billing/billing_${svc}" '{"configure":".*","write":".*","read":".*"}'
done

echo "rabbitmq: vhost 'billing' and service users ready"
```

- [ ] **Step 4: Tạo `deploy/compose.billing.yml`**

```yaml
# Overlay cho hạ tầng DÙNG CHUNG với stack ecommerce: chỉ chạy các job khởi tạo (DB, vhost, user)
# trên network external của ecommerce. Không tham chiếu file nào của repo ecommerce.
#
#   cp deploy/.env.example deploy/.env   # điền mật khẩu
#   docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-sql-init
#   docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-rabbitmq-init
name: billing

networks:
  ecommerce:
    external: true
    name: ${ECOMMERCE_NETWORK:-ecomerce-stack_backbone}

services:
  billing-sql-init:
    image: mcr.microsoft.com/mssql/server:2022-latest
    networks: [ecommerce]
    restart: "no"
    environment:
      ACCEPT_EULA: "Y"
      SA_PASSWORD: ${BILLING_SQLSERVER_SA_PASSWORD:?set in deploy/.env}
      WALLET_DB_PASSWORD: ${BILLING_WALLET_DB_PASSWORD:?set in deploy/.env}
      PAYMENT_DB_PASSWORD: ${BILLING_PAYMENT_DB_PASSWORD:?set in deploy/.env}
    volumes:
      - ./sql/init.sql:/init/init.sql:ro
    # $$ để shell trong container mở rộng biến, giữ mật khẩu khỏi `docker inspect`.
    entrypoint:
      - /bin/bash
      - -c
      - >-
        /opt/mssql-tools18/bin/sqlcmd -S ${BILLING_SQLSERVER_HOST:-sqlserver}
        -U ${BILLING_SQLSERVER_SA_USER:-sa} -P "$$SA_PASSWORD" -C -b
        -v WALLET_DB_PASSWORD="$$WALLET_DB_PASSWORD" PAYMENT_DB_PASSWORD="$$PAYMENT_DB_PASSWORD"
        -i /init/init.sql

  billing-rabbitmq-init:
    image: curlimages/curl:8.10.1
    networks: [ecommerce]
    restart: "no"
    environment:
      RABBITMQ_HOST: ${BILLING_RABBITMQ_HOST:-rabbitmq}
      RABBITMQ_MGMT_PORT: ${BILLING_RABBITMQ_MGMT_PORT:-15672}
      RABBITMQ_ADMIN_USER: ${BILLING_RABBITMQ_ADMIN_USER:-guest}
      RABBITMQ_ADMIN_PASSWORD: ${BILLING_RABBITMQ_ADMIN_PASSWORD:?set in deploy/.env}
      WALLET_MQ_PASSWORD: ${BILLING_WALLET_MQ_PASSWORD:?set in deploy/.env}
      PAYMENT_MQ_PASSWORD: ${BILLING_PAYMENT_MQ_PASSWORD:?set in deploy/.env}
    volumes:
      - ./scripts/init-rabbitmq.sh:/init/init-rabbitmq.sh:ro
    entrypoint: ["/bin/sh", "/init/init-rabbitmq.sh"]
```

- [ ] **Step 5: Kiểm tra cấu hình hợp lệ (không cần chạy stack ecommerce)**

```bash
cp deploy/.env.example deploy/.env
sed -i 's/^\(BILLING_[A-Z_]*PASSWORD\)=$/\1=localdev/' deploy/.env
docker compose -f deploy/compose.billing.yml --env-file deploy/.env config --quiet && echo CONFIG_OK
sh -n deploy/scripts/init-rabbitmq.sh && echo SH_OK
rm deploy/.env
```
Expected: `CONFIG_OK` và `SH_OK`. (`deploy/.env` đã bị `.gitignore` loại; xóa sau khi kiểm tra.)

- [ ] **Step 6: Kiểm tra chạy thật khi stack ecommerce đang chạy (bỏ qua nếu chưa chạy stack, nhưng phải ghi rõ trong báo cáo là đã bỏ qua)**

Với `deploy/.env` điền mật khẩu SA và RabbitMQ trùng stack ecommerce:
```bash
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-sql-init
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-sql-init   # lần 2: idempotent
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-rabbitmq-init
```
Expected: cả ba lệnh exit 0; lần 2 của `billing-sql-init` không lỗi.

- [ ] **Step 7: Commit**

```bash
git add deploy
git commit -m "feat(deploy): add compose overlay to provision billing DBs and RabbitMQ vhost on shared infra"
```

---

### Task 9: CI — Jenkinsfile và Sonar

**Files:**
- Create: `Jenkinsfile`, `sonar-project.properties`

**Interfaces:**
- Consumes: scripts gốc `lint`, `typecheck`, `test:coverage`, `format:check`; tên server SonarQube của Jenkins dùng chung (tham số `SONARQUBE_SERVER`, mặc định `sonarqube` — **phải khớp tên đã cấu hình trên Jenkins của nền tảng**).
- Produces: pipeline 5 stage tuần tự: Install → Static checks → Test → SonarQube → (Quality Gate).

- [ ] **Step 1: Tạo `sonar-project.properties`**

```properties
sonar.projectKey=billing-framework
sonar.projectName=billing-framework
sonar.sources=packages,services
sonar.tests=packages,services,tools
sonar.test.inclusions=**/*.test.ts
sonar.exclusions=**/node_modules/**,**/dist/**,**/*.test.ts
sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.sourceEncoding=UTF-8
```

- [ ] **Step 2: Tạo `Jenkinsfile`**

```groovy
#!/usr/bin/env groovy

// CI cho billing-framework. Agent cần: POSIX shell, Node 22 với corepack, Docker daemon
// (tầng integration về sau dùng testcontainers), và sonar-scanner trong PATH.
pipeline {
    agent any

    parameters {
        string(name: 'SONARQUBE_SERVER', defaultValue: 'sonarqube',
               description: 'Tên SonarQube server đã cấu hình trong Jenkins (phải khớp nền tảng dùng chung)')
    }

    options {
        timeout(time: 30, unit: 'MINUTES')
        timestamps()
        disableConcurrentBuilds(abortPrevious: true)
    }

    stages {
        stage('Install') {
            steps {
                sh 'corepack enable'
                sh 'corepack pnpm install --frozen-lockfile'
            }
        }

        stage('Static checks') {
            steps {
                sh 'corepack pnpm lint'
                sh 'corepack pnpm typecheck'
                sh 'corepack pnpm format:check'
            }
        }

        stage('Test') {
            steps {
                sh 'corepack pnpm test:coverage'
            }
        }

        stage('SonarQube') {
            steps {
                withSonarQubeEnv(params.SONARQUBE_SERVER) {
                    sh 'sonar-scanner'
                }
            }
        }

        stage('Quality Gate') {
            steps {
                timeout(time: 10, unit: 'MINUTES') {
                    waitForQualityGate abortPipeline: true
                }
            }
        }
    }
}
```

- [ ] **Step 3: Chạy chính các lệnh CI cục bộ để chắc chúng đạt**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && corepack pnpm test:coverage
```
Expected: tất cả exit 0, `coverage/lcov.info` được tạo. Nếu `format:check` báo file lệch, chạy `corepack pnpm exec prettier --write .` rồi commit riêng với thông điệp `style: apply prettier`.

- [ ] **Step 4: Commit**

```bash
git add Jenkinsfile sonar-project.properties
git commit -m "ci: add Jenkins pipeline and SonarQube config"
```

---

### Task 10: Tài liệu — README, kiến trúc, ADR

**Files:**
- Create: `README.md`, `docs/architecture/README.md`, `docs/adr/0001-json-contract-over-masstransit.vi.md`, `docs/adr/0002-wallet-ledger-double-entry.vi.md`, `docs/adr/0003-nestjs-wallet-fastify-payment.vi.md`, `docs/adr/0004-shared-platform-isolated-data.vi.md`
- Modify: `docs/superpowers/specs/2026-10-09-billing-framework-design.md` (dòng cấu trúc `docs/` ở mục 2)

**Interfaces:**
- Consumes: các quyết định ở mục 1 của spec.
- Produces: tài liệu mà thành viên mới (và team ecommerce) đọc để chạy repo và hiểu ranh giới.

- [ ] **Step 1: Điều chỉnh spec cho khớp thực tế ngôn ngữ tài liệu**

Trong spec, đổi dòng
`├─ docs/                 # adr/, architecture/, runbooks/ (song ngữ .md / .vi.md)`
thành
`├─ docs/                 # adr/, architecture/, runbooks/ (tiếng Việt, đuôi .vi.md)`

- [ ] **Step 2: Tạo `README.md`**

```markdown
# billing-framework

Hai microservice thanh toán độc lập với ecommerce:

- **payment** (Fastify): giả lập cổng thanh toán — charge, webhook, kịch bản lỗi, sao kê.
- **wallet** (NestJS): ví nạp trước, ledger ghi sổ kép, thanh toán order bất đồng bộ, chống trùng, đối soát.

Thiết kế: [`docs/superpowers/specs/2026-10-09-billing-framework-design.md`](docs/superpowers/specs/2026-10-09-billing-framework-design.md).
Quyết định kiến trúc: [`docs/adr/`](docs/adr/). Quy ước code: [`docs/architecture/README.md`](docs/architecture/README.md).

## Chạy thử

Yêu cầu: Node 22, Docker. pnpm chạy qua corepack (không cần cài riêng).

```bash
corepack enable
corepack pnpm install
corepack pnpm test            # unit + kiểm tra ranh giới kiến trúc
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm --filter @billing/wallet-service dev    # :3001/health
corepack pnpm --filter @billing/payment-service dev   # :3002/health
```

## Hạ tầng dùng chung với ecommerce

Billing dùng chung nền tảng (SQL Server, RabbitMQ, K8s, CI, observability, Vault) nhưng cô lập dữ liệu:
DB, user SQL, vhost và user RabbitMQ riêng. Khởi tạo trên stack ecommerce đang chạy:

```bash
cp deploy/.env.example deploy/.env   # điền mật khẩu
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-sql-init
docker compose -f deploy/compose.billing.yml --env-file deploy/.env run --rm billing-rabbitmq-init
```

Lưu ý: stack ecommerce mặc định không publish cổng SQL Server/RabbitMQ ra máy host; để chạy service
bằng `pnpm dev` trên host cần publish các cổng đó hoặc chạy service trong container cùng network.
Đây là việc cần thống nhất với team ecommerce khi làm Wallet core.

## Hợp đồng với ecommerce

JSON Schema nằm ở `packages/contracts`. Xuất ra file để team ecommerce lấy:

```bash
corepack pnpm --filter @billing/contracts emit    # → packages/contracts/dist/schemas/
```
```

- [ ] **Step 3: Tạo `docs/architecture/README.md`**

```markdown
# Quy ước kiến trúc

## Bốn lớp trong mỗi service

`services/<tên>/src/{domain,application,infrastructure,interface}`

| Lớp | Chứa | Được import | Không được import |
|---|---|---|---|
| `domain` | aggregate, value object, domain service | `@billing/money` | mọi lớp khác, framework, driver, package dùng chung khác |
| `application` | use case, port (interface) | `domain` | `infrastructure`, `interface`, framework, driver |
| `infrastructure` | adapter: DB (Kysely), broker, HTTP client | `application`, `domain` | `interface` |
| `interface` | controller, route, consumer | `application`, `domain` | `infrastructure` |

Nối dây (composition root) ở `src/main.ts` / `src/app.module.ts`, nơi duy nhất được biết cả hai phía.
Các luật này được ESLint ép (`eslint.config.js`) và có test ở `tools/boundaries.test.ts`.

## Ranh giới giữa service

Service này không import code service kia. Giao tiếp chỉ qua `@billing/contracts` (event) hoặc HTTP có hợp đồng.

## Wallet (NestJS): luôn `@Inject(TOKEN)` tường minh

Không dựa vào metadata kiểu tham số của constructor (`emitDecoratorMetadata`): esbuild/tsx không phát
metadata này. Mỗi port có một token (`Symbol`) và adapter được cung cấp bằng token đó.

## Tiền

Mọi số tiền là `Money` (`@billing/money`): số nguyên minor unit + currency. Không dùng `number` thô cho tiền
ngoài ranh giới (JSON event dùng `{ amount, currency }`).

## Correlation id

Header `x-correlation-id` được nhận hoặc sinh ở rìa HTTP và lan truyền bằng `AsyncLocalStorage`;
logger (`createLogger`) tự gắn vào mọi dòng log.
```

- [ ] **Step 4: Tạo bốn ADR (tiếng Việt, ngắn)**

`docs/adr/0001-json-contract-over-masstransit.vi.md`:
```markdown
# ADR-0001: Hợp đồng JSON thuần, không dùng envelope MassTransit

**Trạng thái:** Chấp nhận — 2026-10-09

## Bối cảnh
Ecommerce viết bằng C#/.NET với MassTransit; billing viết bằng Node.js. Hai bên giao tiếp bất đồng bộ qua RabbitMQ.

## Quyết định
Dùng envelope JSON thuần do billing định nghĩa bằng JSON Schema (`packages/contracts`), version trong tên `type`
(`billing.order-paid.v1`), người nhận theo "tolerant reader". Không bám định dạng envelope của MassTransit.

## Hệ quả
- Phía .NET không bị ràng buộc vào thư viện; billing không phụ thuộc chi tiết nội bộ của MassTransit.
- Team ecommerce phải viết một adapter nhỏ nói JSON thuần cho 3 event ở spec mục 4.
- Schema được phát hành như một package/file có phiên bản, hai bên cùng kiểm thử bằng Pact.
```

`docs/adr/0002-wallet-ledger-double-entry.vi.md`:
```markdown
# ADR-0002: Ledger ghi sổ kép bất biến cho wallet

**Trạng thái:** Chấp nhận — 2026-10-09

## Bối cảnh
Wallet phải chống thanh toán trùng và chứng minh được số dư khớp với payment gateway.

## Quyết định
Mọi thay đổi tiền là bút toán chỉ-ghi-thêm với tổng nợ/có bằng 0. Số dư là cột cache cập nhật cùng transaction,
luôn kiểm chứng lại được từ sổ cái. Sai thì ghi bút toán đảo, không sửa dòng cũ. Không dùng event sourcing đầy đủ.

## Phương án đã loại
- Cột số dư + bảng giao dịch phẳng: đối soát yếu, lệch khó phát hiện.
- Event sourcing: vượt phạm vi, tăng chi phí vận hành.

## Hệ quả
Nhiều bảng và kỷ luật hơn, đổi lại đối soát và kiểm toán chính xác.
```

`docs/adr/0003-nestjs-wallet-fastify-payment.vi.md`:
```markdown
# ADR-0003: NestJS cho wallet, Fastify cho payment

**Trạng thái:** Chấp nhận — 2026-10-09

## Quyết định
Wallet có domain phức tạp (ledger, saga, đối soát) nên dùng NestJS để có DI, module và CQRS nhất quán.
Payment chỉ là bộ giả lập nhẹ nên dùng Fastify.

## Hệ quả
Hai bộ quy ước khác nhau. Giảm thiểu bằng: cùng kiến trúc bốn lớp, cùng package dùng chung, và lint ép ranh giới
giống nhau cho cả hai service. Wallet luôn dùng `@Inject(TOKEN)` tường minh.
```

`docs/adr/0004-shared-platform-isolated-data.vi.md`:
```markdown
# ADR-0004: Dùng chung nền tảng, cô lập dữ liệu và broker

**Trạng thái:** Chấp nhận — 2026-10-09

## Quyết định
Dùng chung cụm K8s, CI (Jenkins + SonarQube), observability, Vault và instance SQL Server/RabbitMQ của ecommerce.
Cô lập ở mức dữ liệu: DB riêng, user SQL riêng, vhost RabbitMQ `billing` và user riêng cho từng service.

## Hệ quả
Tiết kiệm vận hành; lỗi billing không chạm dữ liệu order. Đổi lại, phụ thuộc vào độ sẵn sàng của hạ tầng ecommerce
và cần thống nhất cách truy cập cổng từ máy phát triển (xem README).
```

- [ ] **Step 5: Kiểm tra định dạng**

```bash
corepack pnpm format:check
```
Expected: PASS (`docs/` đã nằm trong `.prettierignore`). Nếu `README.md` hoặc `deploy/*.yml` bị báo lệch, chạy `corepack pnpm exec prettier --write README.md deploy` và xem lại diff trước khi commit.

- [ ] **Step 6: Commit**

```bash
git add README.md docs
git commit -m "docs: add README, architecture conventions and foundation ADRs"
```

---

### Task 11: Kiểm chứng toàn bộ và hoàn tất nhánh

**Files:** không tạo file mới.

- [ ] **Step 1: Chạy sạch từ đầu như CI**

```bash
rm -rf node_modules packages/*/node_modules services/*/node_modules coverage
corepack pnpm install --frozen-lockfile
corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && corepack pnpm test:coverage
```
Expected: tất cả exit 0.

- [ ] **Step 2: Đối chiếu tiêu chí hoàn thành của bước 1**

Xác nhận từng mục đều có bằng chứng (lệnh vừa chạy hoặc test):
- Hai service khởi động và trả `/health` kèm `x-correlation-id` (Task 6, 7 Step 6).
- Vi phạm ranh giới bị lint bắt (`tools/boundaries.test.ts` đạt).
- `corepack pnpm --filter @billing/contracts emit` ghi 4 file schema.
- `docker compose ... config --quiet` hợp lệ (Task 8 Step 5); nếu Step 6 của Task 8 không chạy được vì thiếu stack ecommerce, **báo rõ là chưa kiểm chứng trên hạ tầng thật**.

- [ ] **Step 3: Hoàn tất nhánh**

REQUIRED SUB-SKILL: dùng superpowers:finishing-a-development-branch để chọn cách tích hợp `feature/foundation` vào `main`.
