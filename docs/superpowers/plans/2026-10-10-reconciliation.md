# Reconciliation (Step 5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `reconciliation` module to the wallet service that checks ledger integrity and reconciles wallet top-ups against the payment gateway's settlement, stores immutable runs and items, auto-credits only the safe "missing webhook" discrepancy, and exposes an internal API plus a daily worker task.

**Architecture:** Hexagonal slice in `services/wallet` (domain pure functions → application use cases + ports → Kysely/HTTP adapters → Nest controller + worker task). Per-tenant schema tables `reconciliation_runs` / `reconciliation_items` (migration `004`). The gateway side is read through a `SettlementSource` port (HTTP adapter over `GET /settlements`); auto-credit reuses `ApplyPaymentResult` so ledger idempotency is inherited. Spec: `docs/superpowers/specs/2026-10-10-reconciliation-design.md`.

**Tech Stack:** TypeScript (ESM, NodeNext), NestJS 11 + Fastify, Kysely + SQL Server, Vitest (unit `*.test.ts`, integration `*.integration.test.ts` with SQL Server testcontainer), pnpm via `corepack pnpm`.

## Global Constraints

- Work in `C:\Users\ngantran\source\repos\billing-framework` on branch `feature/reconciliation`. Never push or merge. Run commands as `corepack pnpm …` (pnpm is not on PATH).
- Hexagonal layers enforced by ESLint: `domain` imports only `@billing/money` (and other `domain/*`); `application` imports no frameworks/infrastructure/interface; `interface` never imports `infrastructure`; no cross-service imports.
- Code comments are Vietnamese (match the surrounding code); identifiers and error messages are English.
- No secrets in logs or commits. Commit messages end with the trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Money is integer minor units; currencies `VND` | `USD`; amounts read from SQL `bigint` come back as strings → use `toSafeInteger` from `@billing/database`.
- Datetime columns are `datetime2(3)`; write dates through `sqlDate()` from `infrastructure/kysely/mappers.ts`.
- Reconciliation is **read-only by default**: the only automatic ledger write is `MISSING_AT_WALLET` via `ApplyPaymentResult`, behind `RECONCILE_AUTOFIX` (default `true`). Never edit or delete an existing ledger row.
- Runs are immutable: a re-run creates a new run. Only `case_status` and `resolved_*` of an item may change, and only through `ResolveItem`.
- API errors: invalid input → `422`, unknown run/item → `404`, conflicting resolve → `409`.
- Before finishing each task run `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm format:check` (use `corepack pnpm exec prettier --write <files>` to fix) plus the task's tests.

## Spec clarifications decided while planning (applied to the spec in Task 11)

1. `MISSING_AT_WALLET` also covers a topup `FAILED` with `failure_code = 'PAYMENT_UNAVAILABLE'` (`Topup.applySucceeded` already allows this late success).
2. The auto-credit event id is `reconcile:<runId>:<chargeId>` (per run, so a failed attempt's inbox row never blocks a later run); single-credit safety comes from the ledger business key `topup:<id>`.
3. `MISSING_AT_GATEWAY` compares against the settlement of day D **and** D-1 (a webhook can land on D after the gateway completed the charge on D-1).
4. Gateway/wallet totals are informational (stored on the run); only per-item comparison produces discrepancies.
5. Charges whose `metadata.tenantId` is missing or belongs to another tenant are ignored for that tenant's run.
6. A topup tied to a different `chargeId` than the one the gateway reports for the same `reference` is `UNKNOWN_CHARGE` (detail explains).
7. `RUNNING` scheduled runs older than 30 minutes are marked `FAILED` ("abandoned"); a failed scheduled run is retried at most `RECONCILE_MAX_ATTEMPTS` times, at least 15 minutes apart.
8. Items auto-credited by the run are stored with `case_status = RESOLVED`, `resolved_by = system`, `resolution_note = auto-applied by reconciliation`, so `caseStatus=OPEN` lists only what needs a human.

## File Structure

New files (all under `services/wallet/src` unless noted):

| File | Responsibility |
|---|---|
| `domain/reconciliation.ts` (+ `.test.ts`) | Kinds/types, `classifyCharge`, `findMissingAtGateway`, `totalsByCurrency`, day helpers, input validation |
| `infrastructure/kysely/migrations/004-reconciliation.ts` | Tables + indexes |
| `infrastructure/kysely/reconciliation.repository.ts` | `ReconciliationRepository` over Kysely |
| `infrastructure/http-settlement-source.ts` (+ test) | `SettlementSource` over `GET /settlements` |
| `application/run-reconciliation.ts` | `RunReconciliation` (`begin`/`finish`/`execute`) |
| `application/schedule-daily-reconciliation.ts` | Daily scheduler logic |
| `application/background-runs.ts` | Tracks background promises (drain on shutdown) |
| `application/start-manual-reconciliation.ts` | Starts a manual run in the background |
| `application/resolve-reconciliation-item.ts`, `get-reconciliation-run.ts`, `list-reconciliation-items.ts` | Operator use cases |
| `application/reconciliation-views.ts` | JSON views |
| `interface/http/tenant.guard.ts`, `interface/http/reconciliations.controller.ts` | Tenant-only guard + endpoints |
| `test-support-reconciliation.ts` | `FakeSettlement`, `chargeFor`, `seedSucceededTopup`, `startDay` |

Modified: `config.ts`, `application/ports.ts`, `application/errors.ts`, `domain/errors.ts`, `infrastructure/kysely/{schema,unit-of-work,migrations/index}.ts`, `interface/http/{errors,tokens}.ts`, `app.module.ts`, `bootstrap.ts`, `.env.example`, both test config builders, `packages/testing/src/fake-payment-server.ts`, docs.

---

### Task 1: Configuration (`RECONCILE_*`)

**Files:**
- Modify: `services/wallet/src/config.ts`
- Modify: `services/wallet/.env.example`
- Modify: `services/wallet/src/env-example.test.ts`
- Modify: `services/wallet/src/config.test.ts`
- Modify: `services/wallet/src/service.integration.test.ts` (config builder, ~line 61)
- Modify: `services/wallet/src/order-payment.integration.test.ts` (config builder, ~line 24)

**Interfaces:**
- Produces: `WalletConfig.reconciliation: { autofix: boolean; atUtcHour: number; maxAttempts: number; maxItems: number }`.

- [ ] **Step 1: Write the failing tests** — in `config.test.ts` extend the defaults test and add:

```ts
  it('applies the reconciliation defaults and reads overrides', () => {
    expect(loadConfig(minimal).reconciliation).toEqual({
      autofix: true,
      atUtcHour: 2,
      maxAttempts: 3,
      maxItems: 50_000,
    });
    expect(
      loadConfig({
        ...minimal,
        RECONCILE_AUTOFIX: 'false',
        RECONCILE_AT_UTC_HOUR: '23',
        RECONCILE_MAX_ATTEMPTS: '5',
        RECONCILE_MAX_ITEMS: '100',
      }).reconciliation,
    ).toEqual({ autofix: false, atUtcHour: 23, maxAttempts: 5, maxItems: 100 });
  });

  it('rejects invalid reconciliation settings together', () => {
    expect(
      problemsOf({
        ...minimal,
        RECONCILE_AUTOFIX: 'yes',
        RECONCILE_AT_UTC_HOUR: '24',
        RECONCILE_MAX_ATTEMPTS: '0',
        RECONCILE_MAX_ITEMS: '1000001',
      }),
    ).toEqual([
      'RECONCILE_AUTOFIX must be "true" or "false"',
      'RECONCILE_AT_UTC_HOUR must be an integer in 0..23',
      'RECONCILE_MAX_ATTEMPTS must be an integer in 1..20',
      'RECONCILE_MAX_ITEMS must be an integer in 1..1000000',
    ]);
  });
```

In `env-example.test.ts` add `'RECONCILE_AT_UTC_HOUR'`, `'RECONCILE_AUTOFIX'`, `'RECONCILE_MAX_ATTEMPTS'`, `'RECONCILE_MAX_ITEMS'` to the sorted expected list (the list is sorted with `.sort()`, order of literals does not matter).

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm exec vitest run services/wallet/src/config.test.ts services/wallet/src/env-example.test.ts`
Expected: FAIL (`reconciliation` undefined / key list differs).

- [ ] **Step 3: Implement** — in `config.ts`:

Add to the interface block (after `WalletConfig`'s `orders` line the new field) and a type:

```ts
export interface ReconciliationConfig {
  autofix: boolean;
  atUtcHour: number;
  maxAttempts: number;
  maxItems: number;
}
```

Add `reconciliation: ReconciliationConfig;` to `WalletConfig` (after `orders`). In `loadConfig`, after the `workerIntervalMs` line add:

```ts
  const rawAutofix = env.RECONCILE_AUTOFIX?.trim();
  let reconcileAutofix = true;
  if (rawAutofix !== undefined && rawAutofix !== '') {
    if (rawAutofix === 'true') reconcileAutofix = true;
    else if (rawAutofix === 'false') reconcileAutofix = false;
    else problems.push('RECONCILE_AUTOFIX must be "true" or "false"');
  }
  const reconcileAtUtcHour = integer('RECONCILE_AT_UTC_HOUR', 2, 0, 23);
  const reconcileMaxAttempts = integer('RECONCILE_MAX_ATTEMPTS', 3, 1, 20);
  const reconcileMaxItems = integer('RECONCILE_MAX_ITEMS', 50_000, 1, 1_000_000);
```

and in the returned object, after `orders: …`:

```ts
    reconciliation: {
      autofix: reconcileAutofix,
      atUtcHour: reconcileAtUtcHour,
      maxAttempts: reconcileMaxAttempts,
      maxItems: reconcileMaxItems,
    },
```

Append to `.env.example` (after `OUTBOX_BATCH=50`):

```
# Đối soát: tự ghi bù khi mất webhook, giờ UTC bắt đầu chạy lượt ngày D-1, số lần thử tối đa của lượt định kỳ, trần số charge/lệch mỗi lượt
RECONCILE_AUTOFIX=true
RECONCILE_AT_UTC_HOUR=2
RECONCILE_MAX_ATTEMPTS=3
RECONCILE_MAX_ITEMS=50000
```

In both integration-test config builders add `reconciliation: { autofix: true, atUtcHour: 23, maxAttempts: 3, maxItems: 1000 },` (hour 23 with the 10:00 fake clock keeps the scheduled task idle so those tests never call `/settlements`).

- [ ] **Step 4: Run to verify pass**

Run: `corepack pnpm exec vitest run services/wallet/src/config.test.ts services/wallet/src/env-example.test.ts` → PASS. Then `corepack pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add services/wallet
git commit -m "feat(wallet): RECONCILE_* configuration

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Domain — classification, day helpers, validation

**Files:**
- Create: `services/wallet/src/domain/reconciliation.ts`
- Create: `services/wallet/src/domain/reconciliation.test.ts`
- Modify: `services/wallet/src/domain/errors.ts`

**Interfaces:**
- Produces (all exported from `domain/reconciliation.ts`):
  - types `ReconciliationKind`, `AutofixAction`, `CaseStatus`, `GatewayCharge`, `WalletTopupView`, `Discrepancy`
  - `PAYMENT_UNAVAILABLE`, `MAX_NOTE_LENGTH = 500`
  - `classifyCharge(charge: GatewayCharge, topup: WalletTopupView | null): Discrepancy | null`
  - `findMissingAtGateway(topups: readonly WalletTopupView[], gatewayChargeIds: ReadonlySet<string>): Discrepancy[]`
  - `totalsByCurrency(rows: ReadonlyArray<{ currency: string; amount: number }>): Record<string, number>`
  - `parseReconciliationDay(raw: string, now: Date): string`, `dayBounds(day): { from: Date; to: Date }`, `previousDay(day): string`, `yesterdayUtc(now): string`
  - `validateResolution(input: { status: string; note: string; resolvedBy: string }): { status: 'RESOLVED' | 'IGNORED'; note: string; resolvedBy: string }`
- Produces in `domain/errors.ts`: `InvalidReconciliationError`.

- [ ] **Step 1: Add the error** — append to `domain/errors.ts`:

```ts
/** Đầu vào đối soát không hợp lệ (ngày, ghi chú, người xử lý, trạng thái đóng ca). */
export class InvalidReconciliationError extends Error {
  override name = 'InvalidReconciliationError';
}
```

- [ ] **Step 2: Write the failing tests** — `domain/reconciliation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { InvalidReconciliationError } from './errors.js';
import {
  classifyCharge,
  dayBounds,
  findMissingAtGateway,
  parseReconciliationDay,
  previousDay,
  totalsByCurrency,
  validateResolution,
  yesterdayUtc,
  type GatewayCharge,
  type WalletTopupView,
} from './reconciliation.js';

const charge = (overrides: Partial<GatewayCharge> = {}): GatewayCharge => ({
  chargeId: 'ch_1',
  reference: 'tp_1',
  amount: 150000,
  currency: 'VND',
  status: 'SUCCEEDED',
  tenantId: 'acme',
  ...overrides,
});
const topup = (overrides: Partial<WalletTopupView> = {}): WalletTopupView => ({
  id: 'tp_1',
  chargeId: 'ch_1',
  amount: 150000,
  currency: 'VND',
  status: 'SUCCEEDED',
  failureCode: null,
  ...overrides,
});

describe('classifyCharge', () => {
  it('returns null when charge and topup agree', () => {
    expect(classifyCharge(charge(), topup())).toBeNull();
    expect(classifyCharge(charge({ status: 'FAILED' }), topup({ status: 'FAILED' }))).toBeNull();
  });

  it('flags a charge with no topup as UNKNOWN_CHARGE', () => {
    expect(classifyCharge(charge(), null)).toMatchObject({
      kind: 'UNKNOWN_CHARGE',
      chargeId: 'ch_1',
      topupId: null,
      amountGateway: 150000,
      amountWallet: null,
      currency: 'VND',
    });
  });

  it('flags a topup tied to another charge as UNKNOWN_CHARGE', () => {
    expect(classifyCharge(charge(), topup({ chargeId: 'ch_other' }))).toMatchObject({
      kind: 'UNKNOWN_CHARGE',
      detail: { reason: 'topup is tied to another charge', walletChargeId: 'ch_other' },
    });
  });

  it('flags a different amount or currency as AMOUNT_MISMATCH', () => {
    expect(classifyCharge(charge(), topup({ amount: 1 }))).toMatchObject({
      kind: 'AMOUNT_MISMATCH',
      amountGateway: 150000,
      amountWallet: 1,
    });
    expect(classifyCharge(charge(), topup({ currency: 'USD' }))).toMatchObject({
      kind: 'AMOUNT_MISMATCH',
    });
  });

  it.each([
    ['REQUESTED', null, null],
    ['PENDING', 'ch_1', null],
    ['FAILED', 'ch_1', 'PAYMENT_UNAVAILABLE'],
  ] as const)(
    'flags a succeeded charge on a %s topup as MISSING_AT_WALLET',
    (status, chargeId, failureCode) => {
      expect(classifyCharge(charge(), topup({ status, chargeId, failureCode }))).toMatchObject({
        kind: 'MISSING_AT_WALLET',
        topupId: 'tp_1',
        chargeId: 'ch_1',
        amountGateway: 150000,
        amountWallet: 150000,
        currency: 'VND',
      });
    },
  );

  it('flags a succeeded charge on a rejected topup as STATUS_MISMATCH (not auto-fixable)', () => {
    expect(
      classifyCharge(charge(), topup({ status: 'FAILED', failureCode: 'PAYMENT_REJECTED' })),
    ).toMatchObject({ kind: 'STATUS_MISMATCH' });
  });

  it('flags every other status disagreement as STATUS_MISMATCH', () => {
    expect(classifyCharge(charge({ status: 'FAILED' }), topup())).toMatchObject({
      kind: 'STATUS_MISMATCH',
      detail: { gatewayStatus: 'FAILED', walletStatus: 'SUCCEEDED' },
    });
    expect(
      classifyCharge(charge({ status: 'FAILED' }), topup({ status: 'PENDING' })),
    ).toMatchObject({ kind: 'STATUS_MISMATCH' });
  });
});

describe('findMissingAtGateway', () => {
  it('reports succeeded topups whose charge the gateway does not list', () => {
    const missing = findMissingAtGateway(
      [topup(), topup({ id: 'tp_2', chargeId: 'ch_2' }), topup({ id: 'tp_3', chargeId: null })],
      new Set(['ch_1']),
    );
    expect(missing.map((d) => [d.kind, d.topupId, d.chargeId])).toEqual([
      ['MISSING_AT_GATEWAY', 'tp_2', 'ch_2'],
      ['MISSING_AT_GATEWAY', 'tp_3', null],
    ]);
    expect(missing[0]).toMatchObject({ amountWallet: 150000, amountGateway: null, currency: 'VND' });
  });

  it('ignores topups that are not SUCCEEDED', () => {
    expect(findMissingAtGateway([topup({ status: 'PENDING' })], new Set())).toEqual([]);
  });
});

describe('totalsByCurrency', () => {
  it('sums per currency without mixing them', () => {
    expect(
      totalsByCurrency([
        { currency: 'VND', amount: 100 },
        { currency: 'USD', amount: 5 },
        { currency: 'VND', amount: 50 },
      ]),
    ).toEqual({ VND: 150, USD: 5 });
    expect(totalsByCurrency([])).toEqual({});
  });
});

describe('day helpers', () => {
  const now = new Date('2026-10-10T10:00:00.000Z');

  it('accepts today and past days and rejects bad ones', () => {
    expect(parseReconciliationDay('2026-10-10', now)).toBe('2026-10-10');
    expect(parseReconciliationDay('2020-02-29', now)).toBe('2020-02-29');
    for (const bad of ['2026-10-11', '2026-13-01', '2026-02-30', '10/10/2026', '', '2026-10-1']) {
      expect(() => parseReconciliationDay(bad, now), bad).toThrow(InvalidReconciliationError);
    }
  });

  it('computes UTC day bounds, the previous day and yesterday', () => {
    expect(dayBounds('2026-10-10')).toEqual({
      from: new Date('2026-10-10T00:00:00.000Z'),
      to: new Date('2026-10-11T00:00:00.000Z'),
    });
    expect(previousDay('2026-10-01')).toBe('2026-09-30');
    expect(previousDay('2027-01-01')).toBe('2026-12-31');
    expect(yesterdayUtc(new Date('2026-10-10T00:00:00.000Z'))).toBe('2026-10-09');
  });
});

describe('validateResolution', () => {
  it('trims and accepts RESOLVED and IGNORED', () => {
    expect(
      validateResolution({ status: 'RESOLVED', note: '  checked with finance ', resolvedBy: ' ops-1 ' }),
    ).toEqual({ status: 'RESOLVED', note: 'checked with finance', resolvedBy: 'ops-1' });
    expect(validateResolution({ status: 'IGNORED', note: 'x', resolvedBy: 'a' }).status).toBe('IGNORED');
  });

  it('rejects unknown status, blank or too long note, blank or too long resolver', () => {
    const ok = { status: 'RESOLVED', note: 'n', resolvedBy: 'r' };
    expect(() => validateResolution({ ...ok, status: 'OPEN' })).toThrow(InvalidReconciliationError);
    expect(() => validateResolution({ ...ok, note: '   ' })).toThrow(InvalidReconciliationError);
    expect(() => validateResolution({ ...ok, note: 'x'.repeat(501) })).toThrow(InvalidReconciliationError);
    expect(validateResolution({ ...ok, note: 'x'.repeat(500) }).note).toHaveLength(500);
    expect(() => validateResolution({ ...ok, resolvedBy: '' })).toThrow(InvalidReconciliationError);
    expect(() => validateResolution({ ...ok, resolvedBy: 'r'.repeat(65) })).toThrow(
      InvalidReconciliationError,
    );
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `corepack pnpm exec vitest run services/wallet/src/domain/reconciliation.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement** — `domain/reconciliation.ts`:

```ts
import { InvalidReconciliationError } from './errors.js';

export type ReconciliationKind =
  | 'LEDGER_UNBALANCED'
  | 'BALANCE_MISMATCH'
  | 'MISSING_AT_WALLET'
  | 'UNKNOWN_CHARGE'
  | 'MISSING_AT_GATEWAY'
  | 'AMOUNT_MISMATCH'
  | 'STATUS_MISMATCH';

export type AutofixAction = 'NONE' | 'AUTO_APPLIED' | 'FAILED_AUTOFIX';
export type CaseStatus = 'OPEN' | 'RESOLVED' | 'IGNORED';

/** Một charge đã hoàn tất theo sao kê của payment. `tenantId` lấy từ `metadata.tenantId` (null nếu thiếu). */
export interface GatewayCharge {
  readonly chargeId: string;
  readonly reference: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly tenantId: string | null;
}

/** Phần của lần nạp mà đối soát cần so sánh. */
export interface WalletTopupView {
  readonly id: string;
  readonly chargeId: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: 'REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';
  readonly failureCode: string | null;
}

export interface Discrepancy {
  readonly kind: ReconciliationKind;
  readonly chargeId: string | null;
  readonly topupId: string | null;
  readonly amountGateway: number | null;
  readonly amountWallet: number | null;
  readonly currency: string | null;
  readonly detail: Record<string, unknown>;
}

/** Trùng với mã `Topup` dùng khi payment không trả lời; lần nạp loại này vẫn nhận được thành công muộn từ payment. */
export const PAYMENT_UNAVAILABLE = 'PAYMENT_UNAVAILABLE';
export const MAX_NOTE_LENGTH = 500;
const MAX_RESOLVED_BY_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

/** So một charge của payment với lần nạp tương ứng (tìm theo `reference` = topupId); `null` khi khớp. */
export function classifyCharge(
  charge: GatewayCharge,
  topup: WalletTopupView | null,
): Discrepancy | null {
  const base = {
    chargeId: charge.chargeId,
    topupId: topup?.id ?? null,
    amountGateway: charge.amount,
    amountWallet: topup?.amount ?? null,
    currency: charge.currency,
  };
  if (topup === null) {
    return {
      ...base,
      kind: 'UNKNOWN_CHARGE',
      detail: { reason: 'no topup for reference', reference: charge.reference },
    };
  }
  if (topup.amount !== charge.amount || topup.currency !== charge.currency) {
    return {
      ...base,
      kind: 'AMOUNT_MISMATCH',
      detail: { walletCurrency: topup.currency, gatewayCurrency: charge.currency },
    };
  }
  if (topup.chargeId !== null && topup.chargeId !== charge.chargeId) {
    return {
      ...base,
      kind: 'UNKNOWN_CHARGE',
      detail: { reason: 'topup is tied to another charge', walletChargeId: topup.chargeId },
    };
  }
  const statusDetail = {
    gatewayStatus: charge.status,
    walletStatus: topup.status,
    failureCode: topup.failureCode,
  };
  if (charge.status === 'SUCCEEDED') {
    if (topup.status === 'SUCCEEDED') return null;
    const lateSuccess = topup.status === 'FAILED' && topup.failureCode === PAYMENT_UNAVAILABLE;
    if (topup.status === 'REQUESTED' || topup.status === 'PENDING' || lateSuccess) {
      return { ...base, kind: 'MISSING_AT_WALLET', detail: statusDetail };
    }
    return { ...base, kind: 'STATUS_MISMATCH', detail: statusDetail };
  }
  if (topup.status === 'FAILED') return null;
  return { ...base, kind: 'STATUS_MISMATCH', detail: statusDetail };
}

/** Lần nạp đã SUCCEEDED ở wallet mà sao kê (ngày D và D-1) không có charge tương ứng. */
export function findMissingAtGateway(
  topups: readonly WalletTopupView[],
  gatewayChargeIds: ReadonlySet<string>,
): Discrepancy[] {
  return topups
    .filter((t) => t.status === 'SUCCEEDED' && (t.chargeId === null || !gatewayChargeIds.has(t.chargeId)))
    .map((t) => ({
      kind: 'MISSING_AT_GATEWAY' as const,
      chargeId: t.chargeId,
      topupId: t.id,
      amountGateway: null,
      amountWallet: t.amount,
      currency: t.currency,
      detail: { walletStatus: t.status },
    }));
}

/** Tổng theo từng đồng tiền; VND và USD không bao giờ cộng lẫn nhau. */
export function totalsByCurrency(
  rows: ReadonlyArray<{ currency: string; amount: number }>,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows) totals[row.currency] = (totals[row.currency] ?? 0) + row.amount;
  return totals;
}

/** Ngày đối soát `YYYY-MM-DD` (UTC): đúng định dạng, đúng lịch, không ở tương lai. */
export function parseReconciliationDay(raw: string, now: Date): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new InvalidReconciliationError('date must be formatted as YYYY-MM-DD');
  }
  const from = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== raw) {
    throw new InvalidReconciliationError('date is not a valid calendar date');
  }
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (from.getTime() > startOfToday) {
    throw new InvalidReconciliationError('date must not be in the future');
  }
  return raw;
}

export function dayBounds(day: string): { from: Date; to: Date } {
  const from = new Date(`${day}T00:00:00.000Z`);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

export function previousDay(day: string): string {
  return new Date(dayBounds(day).from.getTime() - DAY_MS).toISOString().slice(0, 10);
}

export function yesterdayUtc(now: Date): string {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfToday - DAY_MS).toISOString().slice(0, 10);
}

export interface Resolution {
  status: 'RESOLVED' | 'IGNORED';
  note: string;
  resolvedBy: string;
}

export function validateResolution(input: {
  status: string;
  note: string;
  resolvedBy: string;
}): Resolution {
  if (input.status !== 'RESOLVED' && input.status !== 'IGNORED') {
    throw new InvalidReconciliationError('status must be RESOLVED or IGNORED');
  }
  const note = input.note.trim();
  if (note.length < 1 || note.length > MAX_NOTE_LENGTH) {
    throw new InvalidReconciliationError(`note must be 1..${MAX_NOTE_LENGTH} characters`);
  }
  const resolvedBy = input.resolvedBy.trim();
  if (resolvedBy.length < 1 || resolvedBy.length > MAX_RESOLVED_BY_LENGTH) {
    throw new InvalidReconciliationError(`resolvedBy must be 1..${MAX_RESOLVED_BY_LENGTH} characters`);
  }
  return { status: input.status, note, resolvedBy };
}
```

- [ ] **Step 5: Run to verify pass** — `corepack pnpm exec vitest run services/wallet/src/domain/reconciliation.test.ts` → PASS; `corepack pnpm lint` (checks the domain import boundary) → clean.

- [ ] **Step 6: Commit**

```bash
git add services/wallet/src/domain
git commit -m "feat(wallet): reconciliation domain (classification, day helpers, validation)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Migration `004-reconciliation` and Kysely schema types

**Files:**
- Create: `services/wallet/src/infrastructure/kysely/migrations/004-reconciliation.ts`
- Modify: `services/wallet/src/infrastructure/kysely/migrations/index.ts`
- Modify: `services/wallet/src/infrastructure/kysely/schema.ts`
- Create: `services/wallet/src/infrastructure/kysely/reconciliation-migration.integration.test.ts`

**Interfaces:**
- Produces: tables `reconciliation_runs`, `reconciliation_items` in each tenant schema; Kysely types `ReconciliationRunsTable`, `ReconciliationItemsTable` and `WalletDatabase.reconciliation_runs` / `.reconciliation_items`.

- [ ] **Step 1: Write the failing test** — `reconciliation-migration.integration.test.ts` (mirror `orders-migration.integration.test.ts`):

```ts
import { createDatabase, dateTime } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantId } from '../../domain/tenant-id.js';
import { provisionTenants } from './provisioning.js';

let testDb: TestDatabase;
let db: Kysely<unknown>;
const when = () => dateTime(new Date('2026-10-10T10:00:00.000Z'));
const t = (name: string) => sql.id('t_acme', name);
const sqlNumber = async (work: Promise<unknown>): Promise<number | undefined> =>
  work.then(
    () => undefined,
    (error: { number?: number }) => error.number,
  );

beforeAll(async () => {
  testDb = await createTestDatabase('recmig');
  db = createDatabase<unknown>(testDb.config);
  await provisionTenants(db, [TenantId.parse('acme')]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
});

const insertRun = (id: string, day: string, status: string, by: string) =>
  sql`insert into ${t('reconciliation_runs')}
    (id, run_day, status, triggered_by, gateway_totals, wallet_totals, item_count, started_at)
    values (${id}, ${day}, ${status}, ${by}, '{}', '{}', 0, ${when()})`.execute(db);

describe('004-reconciliation', () => {
  it('allows one non-failed SCHEDULED run per day but any number of MANUAL or FAILED ones', async () => {
    await insertRun('r1', '2026-10-09', 'COMPLETED', 'SCHEDULED');
    expect(await sqlNumber(insertRun('r2', '2026-10-09', 'RUNNING', 'SCHEDULED'))).toBe(2601);
    await insertRun('r3', '2026-10-09', 'COMPLETED', 'MANUAL');
    await insertRun('r4', '2026-10-09', 'COMPLETED', 'MANUAL');
    await insertRun('r5', '2026-10-08', 'FAILED', 'SCHEDULED');
    await insertRun('r6', '2026-10-08', 'FAILED', 'SCHEDULED');
    await insertRun('r7', '2026-10-08', 'RUNNING', 'SCHEDULED');
  });

  it('rejects unknown statuses and triggers', async () => {
    expect(await sqlNumber(insertRun('bad1', '2026-10-01', 'BOGUS', 'MANUAL'))).toBe(547);
    expect(await sqlNumber(insertRun('bad2', '2026-10-01', 'COMPLETED', 'BOGUS'))).toBe(547);
  });

  it('keeps items tied to a run and constrains kind, action and case status', async () => {
    const insertItem = (id: string, runId: string, kind: string, action: string, caseStatus: string) =>
      sql`insert into ${t('reconciliation_items')}
        (id, run_id, kind, detail, action, case_status, created_at)
        values (${id}, ${runId}, ${kind}, '{}', ${action}, ${caseStatus}, ${when()})`.execute(db);
    await insertItem('i1', 'r1', 'MISSING_AT_WALLET', 'NONE', 'OPEN');
    expect(await sqlNumber(insertItem('i1', 'r1', 'MISSING_AT_WALLET', 'NONE', 'OPEN'))).toBe(2627);
    expect(await sqlNumber(insertItem('i2', 'nope', 'MISSING_AT_WALLET', 'NONE', 'OPEN'))).toBe(547);
    expect(await sqlNumber(insertItem('i3', 'r1', 'BOGUS', 'NONE', 'OPEN'))).toBe(547);
    expect(await sqlNumber(insertItem('i4', 'r1', 'MISSING_AT_WALLET', 'BOGUS', 'OPEN'))).toBe(547);
    expect(await sqlNumber(insertItem('i5', 'r1', 'MISSING_AT_WALLET', 'NONE', 'BOGUS'))).toBe(547);
  });
});
```
- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm test:integration reconciliation-migration` → FAIL (table missing).

- [ ] **Step 3: Implement** — `004-reconciliation.ts`:

```ts
import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Đối soát: các lượt chạy (bất biến) và các dòng lệch kèm trạng thái ca. Chạy trong schema của một tenant. */
export const reconciliationMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    await sql`
      create table ${t('reconciliation_runs')} (
        id nvarchar(64) not null primary key,
        run_day nvarchar(10) not null,
        status nvarchar(10) not null,
        triggered_by nvarchar(10) not null,
        failure_reason nvarchar(500) null,
        gateway_totals nvarchar(max) not null,
        wallet_totals nvarchar(max) not null,
        item_count int not null,
        started_at datetime2(3) not null,
        finished_at datetime2(3) null,
        constraint ck_reconciliation_runs_status check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
        constraint ck_reconciliation_runs_triggered_by check (triggered_by in ('SCHEDULED', 'MANUAL'))
      )`.execute(db);
    // Mỗi ngày chỉ một lượt định kỳ chưa thất bại: worker chạy song song hay chạy lại không tạo lượt trùng.
    await sql`
      create unique index uq_reconciliation_runs_scheduled on ${t('reconciliation_runs')} (run_day)
      where triggered_by = 'SCHEDULED' and status <> 'FAILED'`.execute(db);
    await sql`create index ix_reconciliation_runs_day on ${t('reconciliation_runs')} (run_day, started_at)`.execute(
      db,
    );

    await sql`
      create table ${t('reconciliation_items')} (
        seq bigint identity(1, 1) not null primary key,
        id nvarchar(64) not null,
        run_id nvarchar(64) not null references ${t('reconciliation_runs')} (id),
        kind nvarchar(24) not null,
        charge_id nvarchar(64) null,
        topup_id nvarchar(64) null,
        amount_gateway bigint null,
        amount_wallet bigint null,
        currency nvarchar(3) null,
        detail nvarchar(max) not null,
        action nvarchar(16) not null,
        case_status nvarchar(10) not null,
        resolved_by nvarchar(64) null,
        resolution_note nvarchar(500) null,
        resolved_at datetime2(3) null,
        created_at datetime2(3) not null,
        constraint uq_reconciliation_items_id unique (id),
        constraint ck_reconciliation_items_kind check (kind in (
          'LEDGER_UNBALANCED', 'BALANCE_MISMATCH', 'MISSING_AT_WALLET', 'UNKNOWN_CHARGE',
          'MISSING_AT_GATEWAY', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH')),
        constraint ck_reconciliation_items_action check (action in ('NONE', 'AUTO_APPLIED', 'FAILED_AUTOFIX')),
        constraint ck_reconciliation_items_case_status check (case_status in ('OPEN', 'RESOLVED', 'IGNORED'))
      )`.execute(db);
    await sql`create index ix_reconciliation_items_run on ${t('reconciliation_items')} (run_id, case_status, seq)`.execute(
      db,
    );
  },
});
```

`migrations/index.ts`: import `reconciliationMigration` from `'./004-reconciliation.js'` and add `'004-reconciliation': reconciliationMigration(schema),`.

`schema.ts`: append before `WalletDatabase`:

```ts
export interface ReconciliationRunsTable {
  id: string;
  run_day: string;
  status: string;
  triggered_by: string;
  failure_reason: string | null;
  gateway_totals: string;
  wallet_totals: string;
  item_count: number;
  started_at: Date;
  finished_at: Date | null;
}

export interface ReconciliationItemsTable {
  /** identity bigint: đọc về là chuỗi, không ghi. */
  seq: Generated<string>;
  id: string;
  run_id: string;
  kind: string;
  charge_id: string | null;
  topup_id: string | null;
  amount_gateway: ColumnType<string | null, number | null, number | null>;
  amount_wallet: ColumnType<string | null, number | null, number | null>;
  currency: string | null;
  detail: string;
  action: string;
  case_status: string;
  resolved_by: string | null;
  resolution_note: string | null;
  resolved_at: Date | null;
  created_at: Date;
}
```

and add `reconciliation_runs: ReconciliationRunsTable; reconciliation_items: ReconciliationItemsTable;` to `WalletDatabase`.

- [ ] **Step 4: Run to verify pass**

Run: `corepack pnpm test:integration reconciliation-migration provisioning orders-migration` → PASS. If any existing test pins the migration name list (e.g. `provisioning.integration.test.ts` expecting `['001-ledger','002-topups','003-orders']`), update that expectation to include `'004-reconciliation'` — that change is expected. `corepack pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add services/wallet
git commit -m "feat(wallet): tenant migration 004 for reconciliation runs and items

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Ports, errors, Kysely repository, unit-of-work wiring

**Files:**
- Modify: `services/wallet/src/application/errors.ts`
- Modify: `services/wallet/src/application/ports.ts`
- Create: `services/wallet/src/infrastructure/kysely/reconciliation.repository.ts`
- Modify: `services/wallet/src/infrastructure/kysely/unit-of-work.ts`
- Create: `services/wallet/src/infrastructure/kysely/reconciliation.repository.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 domain types; Task 3 tables.
- Produces (ports.ts): `RunStatus`, `RunTrigger`, `ReconciliationRun`, `NewReconciliationItem`, `ReconciliationItem`, `ReconciliationRepository`, `SettlementSource`; `Repositories.reconciliation`.
- Produces (errors.ts): `SettlementUnavailableError`, `ReconciliationTooLargeError`, `ReconciliationNotFoundError`, `ReconciliationItemNotFoundError`, `ReconciliationConflictError`.

- [ ] **Step 1: Errors and ports** — append to `application/errors.ts`:

```ts
/** Không đọc được sao kê từ payment (mạng, HTTP lỗi, phản hồi sai dạng). */
export class SettlementUnavailableError extends Error {
  override name = 'SettlementUnavailableError';
}

/** Sao kê hoặc số dòng lệch vượt `RECONCILE_MAX_ITEMS`. */
export class ReconciliationTooLargeError extends Error {
  override name = 'ReconciliationTooLargeError';
}

export class ReconciliationNotFoundError extends Error {
  override name = 'ReconciliationNotFoundError';
}

export class ReconciliationItemNotFoundError extends Error {
  override name = 'ReconciliationItemNotFoundError';
}

/** Ca đã được đóng với giá trị khác. */
export class ReconciliationConflictError extends Error {
  override name = 'ReconciliationConflictError';
}
```

In `application/ports.ts` add the import
`import type { AutofixAction, CaseStatus, GatewayCharge, ReconciliationKind, WalletTopupView } from '../domain/reconciliation.js';`
and append at the end of the file:

```ts
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED';
export type RunTrigger = 'SCHEDULED' | 'MANUAL';

export interface ReconciliationRun {
  id: string;
  day: string;
  status: RunStatus;
  triggeredBy: RunTrigger;
  failureReason: string | null;
  gatewayTotals: Record<string, number>;
  walletTotals: Record<string, number>;
  itemCount: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface NewReconciliationItem {
  id: string;
  kind: ReconciliationKind;
  chargeId: string | null;
  topupId: string | null;
  amountGateway: number | null;
  amountWallet: number | null;
  currency: string | null;
  detail: Record<string, unknown>;
  action: AutofixAction;
}

export interface ReconciliationItem extends NewReconciliationItem {
  /** Số thứ tự tăng dần toàn schema; dùng làm cursor phân trang. */
  seq: number;
  runId: string;
  caseStatus: CaseStatus;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

export interface ReconciliationRepository {
  /** `false` khi lượt `SCHEDULED` của ngày này đã có (đang chạy hoặc đã xong): không tạo lượt trùng. */
  startRun(run: {
    id: string;
    day: string;
    triggeredBy: RunTrigger;
    startedAt: Date;
  }): Promise<boolean>;
  /** Ghi các dòng lệch và đóng lượt `COMPLETED`. Dòng `AUTO_APPLIED` được ghi sẵn ở trạng thái `RESOLVED` bởi `system`. */
  completeRun(
    id: string,
    input: {
      gatewayTotals: Record<string, number>;
      walletTotals: Record<string, number>;
      items: readonly NewReconciliationItem[];
      finishedAt: Date;
    },
  ): Promise<void>;
  failRun(id: string, reason: string, finishedAt: Date): Promise<void>;
  /** Đánh dấu `FAILED` các lượt còn `RUNNING` bắt đầu trước `startedBefore`; trả về số lượt bị đóng. */
  failStaleRuns(startedBefore: Date, reason: string, now: Date): Promise<number>;
  findRun(id: string): Promise<ReconciliationRun | null>;
  /** Số lượt định kỳ của ngày theo trạng thái, và lúc lượt `FAILED` gần nhất kết thúc. */
  scheduledRunsFor(day: string): Promise<{
    running: number;
    completed: number;
    failed: number;
    lastFailedAt: Date | null;
  }>;
  listItems(query: {
    runId: string;
    caseStatus: CaseStatus | null;
    afterSeq: number;
    limit: number;
  }): Promise<ReconciliationItem[]>;
  /** Đọc và khóa (UPDLOCK) một dòng lệch. */
  lockItem(id: string): Promise<ReconciliationItem | null>;
  /** Chỉ đóng dòng còn `OPEN`. */
  resolveItem(
    id: string,
    resolution: { status: 'RESOLVED' | 'IGNORED'; resolvedBy: string; note: string; at: Date },
  ): Promise<void>;
  findTopupsByIds(ids: readonly string[]): Promise<WalletTopupView[]>;
  /** Lần nạp `SUCCEEDED` có `completed_at` trong `[from, to)`. */
  listSucceededTopups(from: Date, to: Date): Promise<WalletTopupView[]>;
  /** Giao dịch có tổng các dòng khác 0 (tối đa 1000). */
  findUnbalancedTransactions(): Promise<Array<{ transactionId: string; total: number }>>;
  /** Tài khoản có số dư cache khác tổng các dòng sổ cái của nó (tối đa 1000). */
  findBalanceMismatches(): Promise<
    Array<{ accountId: string; balance: number; ledgerTotal: number }>
  >;
}

export interface SettlementSource {
  /** Mọi charge hoàn tất trong ngày UTC `day` (mọi tenant). Ném `SettlementUnavailableError` hoặc `ReconciliationTooLargeError`. */
  fetchDay(day: string, maxCharges: number): Promise<GatewayCharge[]>;
}
```

Add `reconciliation: ReconciliationRepository;` to the `Repositories` interface.

- [ ] **Step 2: Write the failing repository test** — `reconciliation.repository.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import type {
  NewReconciliationItem,
  ReconciliationRepository,
} from '../../application/ports.js';
import {
  createHarness,
  expectLedgerInvariants,
  seedTopup,
  silentLogger,
  type Harness,
} from '../../test-support.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.000Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

const item = (
  id: string,
  overrides: Partial<NewReconciliationItem> = {},
): NewReconciliationItem => ({
  id,
  kind: 'MISSING_AT_WALLET',
  chargeId: `ch_${id}`,
  topupId: `tp_${id}`,
  amountGateway: 1000,
  amountWallet: 1000,
  currency: 'VND',
  detail: { note: id },
  action: 'NONE',
  ...overrides,
});
const repo = <T>(work: (r: ReconciliationRepository) => Promise<T>) =>
  h.uow.run(h.acme, ({ reconciliation }) => work(reconciliation));

describe('runs', () => {
  it('starts a run, completes it with items, and reads it back', async () => {
    expect(
      await repo((r) =>
        r.startRun({ id: 'run-a', day: '2026-09-01', triggeredBy: 'MANUAL', startedAt: t0 }),
      ),
    ).toBe(true);
    await repo((r) =>
      r.completeRun('run-a', {
        gatewayTotals: { VND: 3000 },
        walletTotals: { VND: 2000, USD: 5 },
        items: [
          item('a1'),
          item('a2', { action: 'AUTO_APPLIED' }),
          item('a3', {
            kind: 'LEDGER_UNBALANCED',
            chargeId: null,
            topupId: null,
            amountGateway: null,
            amountWallet: null,
            currency: null,
          }),
        ],
        finishedAt: at(1),
      }),
    );
    const run = await repo((r) => r.findRun('run-a'));
    expect(run).toMatchObject({
      id: 'run-a',
      day: '2026-09-01',
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      failureReason: null,
      gatewayTotals: { VND: 3000 },
      walletTotals: { VND: 2000, USD: 5 },
      itemCount: 3,
    });
    expect(run?.finishedAt).toEqual(at(1));
    expect(await repo((r) => r.findRun('missing'))).toBeNull();
  });

  it('stores auto-applied items as RESOLVED by system and the rest as OPEN, paged by seq', async () => {
    const first = await repo((r) =>
      r.listItems({ runId: 'run-a', caseStatus: null, afterSeq: 0, limit: 2 }),
    );
    expect(first.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(first[0]).toMatchObject({
      caseStatus: 'OPEN',
      resolvedBy: null,
      detail: { note: 'a1' },
      amountGateway: 1000,
    });
    expect(first[1]).toMatchObject({
      caseStatus: 'RESOLVED',
      resolvedBy: 'system',
      resolutionNote: 'auto-applied by reconciliation',
      action: 'AUTO_APPLIED',
    });
    const second = await repo((r) =>
      r.listItems({ runId: 'run-a', caseStatus: null, afterSeq: first[1]!.seq, limit: 10 }),
    );
    expect(second.map((i) => i.id)).toEqual(['a3']);
    expect(second[0]).toMatchObject({
      kind: 'LEDGER_UNBALANCED',
      chargeId: null,
      amountGateway: null,
      currency: null,
    });
    const open = await repo((r) =>
      r.listItems({ runId: 'run-a', caseStatus: 'OPEN', afterSeq: 0, limit: 10 }),
    );
    expect(open.map((i) => i.id)).toEqual(['a1', 'a3']);
  });

  it('allows a second SCHEDULED start only after the first one failed', async () => {
    const start = (id: string) =>
      repo((r) =>
        r.startRun({ id, day: '2026-09-02', triggeredBy: 'SCHEDULED', startedAt: t0 }),
      );
    expect(await start('s1')).toBe(true);
    expect(await start('s2')).toBe(false);
    await repo((r) => r.failRun('s1', 'gateway down', at(5)));
    expect(await repo((r) => r.findRun('s1'))).toMatchObject({
      status: 'FAILED',
      failureReason: 'gateway down',
    });
    expect(await start('s3')).toBe(true);
    expect(await repo((r) => r.scheduledRunsFor('2026-09-02'))).toEqual({
      running: 1,
      completed: 0,
      failed: 1,
      lastFailedAt: at(5),
    });
    expect(await repo((r) => r.scheduledRunsFor('2026-01-01'))).toEqual({
      running: 0,
      completed: 0,
      failed: 0,
      lastFailedAt: null,
    });
  });

  it('fails only RUNNING runs older than the cutoff', async () => {
    await repo((r) =>
      r.startRun({ id: 'old', day: '2026-09-03', triggeredBy: 'MANUAL', startedAt: at(-60) }),
    );
    await repo((r) =>
      r.startRun({ id: 'new', day: '2026-09-03', triggeredBy: 'MANUAL', startedAt: at(-1) }),
    );
    expect(await repo((r) => r.failStaleRuns(at(-30), 'abandoned', t0))).toBe(1);
    expect(await repo((r) => r.findRun('old'))).toMatchObject({
      status: 'FAILED',
      failureReason: 'abandoned',
    });
    expect(await repo((r) => r.findRun('new'))).toMatchObject({ status: 'RUNNING' });
  });
});

describe('items', () => {
  it('resolves an open item once and refuses to touch a closed one', async () => {
    const locked = await h.uow.run(h.acme, async ({ reconciliation }) => {
      const found = await reconciliation.lockItem('a1');
      await reconciliation.resolveItem('a1', {
        status: 'RESOLVED',
        resolvedBy: 'ops-1',
        note: 'checked',
        at: at(2),
      });
      return found;
    });
    expect(locked).toMatchObject({ id: 'a1', caseStatus: 'OPEN' });
    const after = await repo((r) => r.lockItem('a1'));
    expect(after).toMatchObject({
      caseStatus: 'RESOLVED',
      resolvedBy: 'ops-1',
      resolutionNote: 'checked',
    });
    expect(after?.resolvedAt).toEqual(at(2));
    await repo((r) =>
      r.resolveItem('a1', { status: 'IGNORED', resolvedBy: 'ops-2', note: 'again', at: at(3) }),
    );
    expect(await repo((r) => r.lockItem('a1'))).toMatchObject({
      caseStatus: 'RESOLVED',
      resolvedBy: 'ops-1',
    });
    expect(await repo((r) => r.lockItem('nope'))).toBeNull();
  });
});

describe('wallet-side reads', () => {
  it('finds topups by id (more than one chunk) and lists succeeded ones by completion time', async () => {
    const pending = await seedTopup(h, { state: 'PENDING', amount: 5000 });
    const settled = await seedTopup(h, { state: 'PENDING', amount: 7000 });
    h.clock.set('2026-08-15T10:00:00.000Z');
    await new ApplyPaymentResult({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      log: silentLogger,
    }).execute({
      tenant: h.acme,
      eventId: 'evt_repo_1',
      type: 'charge.succeeded',
      chargeId: settled.chargeId,
      reference: settled.topupId,
      amount: settled.amount,
      currency: settled.currency,
    });

    const ids = [
      pending.topupId,
      settled.topupId,
      ...Array.from({ length: 700 }, (_, i) => `nope_${i}`),
    ];
    const found = await repo((r) => r.findTopupsByIds(ids));
    expect(found.map((t) => t.id).sort()).toEqual([pending.topupId, settled.topupId].sort());
    expect(found.find((t) => t.id === settled.topupId)).toEqual({
      id: settled.topupId,
      chargeId: settled.chargeId,
      amount: 7000,
      currency: 'VND',
      status: 'SUCCEEDED',
      failureCode: null,
    });
    expect(await repo((r) => r.findTopupsByIds([]))).toEqual([]);

    const between = (from: string, to: string) =>
      repo((r) => r.listSucceededTopups(new Date(from), new Date(to)));
    expect(
      (await between('2026-08-15T00:00:00.000Z', '2026-08-16T00:00:00.000Z')).map((t) => t.id),
    ).toEqual([settled.topupId]);
    expect(await between('2026-08-16T00:00:00.000Z', '2026-08-17T00:00:00.000Z')).toEqual([]);
    expect(await between('2026-08-14T00:00:00.000Z', '2026-08-15T10:00:00.000Z')).toEqual([]);
  });

  it('reports no ledger problems on a consistent tenant', async () => {
    expect(await repo((r) => r.findUnbalancedTransactions())).toEqual([]);
    expect(await repo((r) => r.findBalanceMismatches())).toEqual([]);
    await expectLedgerInvariants(h, h.acme);
  });
});
```

(Tampering cases for the ledger checks live in Task 6 with their own database.)

- [ ] **Step 3: Run to verify failure**

Run: `corepack pnpm test:integration reconciliation.repository` → FAIL (repository missing).

- [ ] **Step 4: Implement the repository** — `infrastructure/kysely/reconciliation.repository.ts`:

```ts
import { isUniqueViolation, toSafeInteger } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type {
  NewReconciliationItem,
  ReconciliationItem,
  ReconciliationRepository,
  ReconciliationRun,
  RunStatus,
  RunTrigger,
} from '../../application/ports.js';
import type { CaseStatus, WalletTopupView } from '../../domain/reconciliation.js';
import { sqlDate } from './mappers.js';
import type {
  ReconciliationItemsTable,
  ReconciliationRunsTable,
  TopupsTable,
  WalletDatabase,
} from './schema.js';

/** SQL Server giới hạn 2100 tham số mỗi câu lệnh: chia nhỏ các lệnh insert và `in (...)`. */
const ITEM_CHUNK = 100;
const ID_CHUNK = 500;
const LEDGER_CHECK_LIMIT = 1000;
const SYSTEM = 'system';
const AUTO_NOTE = 'auto-applied by reconciliation';

const chunks = <T>(values: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
};

const nullableInt = (value: string | null): number | null =>
  value === null ? null : toSafeInteger(value);

function rowToRun(row: Selectable<ReconciliationRunsTable>): ReconciliationRun {
  return {
    id: row.id,
    day: row.run_day,
    status: row.status as RunStatus,
    triggeredBy: row.triggered_by as RunTrigger,
    failureReason: row.failure_reason,
    gatewayTotals: JSON.parse(row.gateway_totals) as Record<string, number>,
    walletTotals: JSON.parse(row.wallet_totals) as Record<string, number>,
    itemCount: row.item_count,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToItem(row: Selectable<ReconciliationItemsTable>): ReconciliationItem {
  return {
    seq: Number(row.seq),
    id: row.id,
    runId: row.run_id,
    kind: row.kind as ReconciliationItem['kind'],
    chargeId: row.charge_id,
    topupId: row.topup_id,
    amountGateway: nullableInt(row.amount_gateway),
    amountWallet: nullableInt(row.amount_wallet),
    currency: row.currency,
    detail: JSON.parse(row.detail) as Record<string, unknown>,
    action: row.action as ReconciliationItem['action'],
    caseStatus: row.case_status as CaseStatus,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

function rowToTopupView(row: Selectable<TopupsTable>): WalletTopupView {
  return {
    id: row.id,
    chargeId: row.charge_id,
    amount: toSafeInteger(row.amount),
    currency: row.currency,
    status: row.status as WalletTopupView['status'],
    failureCode: row.failure_code,
  };
}

const ITEM_COLUMNS = sql.raw(
  'seq, id, run_id, kind, charge_id, topup_id, amount_gateway, amount_wallet, currency, detail, action, case_status, resolved_by, resolution_note, resolved_at, created_at',
);

export class KyselyReconciliationRepository implements ReconciliationRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async startRun(run: {
    id: string;
    day: string;
    triggeredBy: RunTrigger;
    startedAt: Date;
  }): Promise<boolean> {
    try {
      await this.db
        .insertInto('reconciliation_runs')
        .values({
          id: run.id,
          run_day: run.day,
          status: 'RUNNING',
          triggered_by: run.triggeredBy,
          failure_reason: null,
          gateway_totals: '{}',
          wallet_totals: '{}',
          item_count: 0,
          started_at: sqlDate(run.startedAt),
          finished_at: null,
        })
        .execute();
      return true;
    } catch (error) {
      // Chỉ chỉ mục "một lượt định kỳ mỗi ngày" mới là trùng bình thường; mọi trùng khóa khác là lỗi thật.
      if (isUniqueViolation(error) && run.triggeredBy === 'SCHEDULED') return false;
      throw error;
    }
  }

  async completeRun(
    id: string,
    input: {
      gatewayTotals: Record<string, number>;
      walletTotals: Record<string, number>;
      items: readonly NewReconciliationItem[];
      finishedAt: Date;
    },
  ): Promise<void> {
    for (const part of chunks(input.items, ITEM_CHUNK)) {
      await this.db
        .insertInto('reconciliation_items')
        .values(
          part.map((item) => {
            const auto = item.action === 'AUTO_APPLIED';
            return {
              id: item.id,
              run_id: id,
              kind: item.kind,
              charge_id: item.chargeId,
              topup_id: item.topupId,
              amount_gateway: item.amountGateway,
              amount_wallet: item.amountWallet,
              currency: item.currency,
              detail: JSON.stringify(item.detail),
              action: item.action,
              case_status: auto ? 'RESOLVED' : 'OPEN',
              resolved_by: auto ? SYSTEM : null,
              resolution_note: auto ? AUTO_NOTE : null,
              resolved_at: auto ? sqlDate(input.finishedAt) : null,
              created_at: sqlDate(input.finishedAt),
            };
          }),
        )
        .execute();
    }
    await this.db
      .updateTable('reconciliation_runs')
      .set({
        status: 'COMPLETED',
        gateway_totals: JSON.stringify(input.gatewayTotals),
        wallet_totals: JSON.stringify(input.walletTotals),
        item_count: input.items.length,
        finished_at: sqlDate(input.finishedAt),
      })
      .where('id', '=', id)
      .where('status', '=', 'RUNNING')
      .execute();
  }

  async failRun(id: string, reason: string, finishedAt: Date): Promise<void> {
    await this.db
      .updateTable('reconciliation_runs')
      .set({
        status: 'FAILED',
        failure_reason: reason.slice(0, 500),
        finished_at: sqlDate(finishedAt),
      })
      .where('id', '=', id)
      .where('status', '=', 'RUNNING')
      .execute();
  }

  async failStaleRuns(startedBefore: Date, reason: string, now: Date): Promise<number> {
    const result = await this.db
      .updateTable('reconciliation_runs')
      .set({ status: 'FAILED', failure_reason: reason.slice(0, 500), finished_at: sqlDate(now) })
      .where('status', '=', 'RUNNING')
      .where('started_at', '<', sqlDate(startedBefore))
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async findRun(id: string): Promise<ReconciliationRun | null> {
    const row = await this.db
      .selectFrom('reconciliation_runs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToRun(row) : null;
  }

  async scheduledRunsFor(day: string): Promise<{
    running: number;
    completed: number;
    failed: number;
    lastFailedAt: Date | null;
  }> {
    const rows = await this.db
      .selectFrom('reconciliation_runs')
      .select(['status', 'finished_at'])
      .where('run_day', '=', day)
      .where('triggered_by', '=', 'SCHEDULED')
      .execute();
    const failed = rows.filter((row) => row.status === 'FAILED');
    const times = failed.flatMap((row) => (row.finished_at ? [row.finished_at.getTime()] : []));
    return {
      running: rows.filter((row) => row.status === 'RUNNING').length,
      completed: rows.filter((row) => row.status === 'COMPLETED').length,
      failed: failed.length,
      lastFailedAt: times.length > 0 ? new Date(Math.max(...times)) : null,
    };
  }

  async listItems(query: {
    runId: string;
    caseStatus: CaseStatus | null;
    afterSeq: number;
    limit: number;
  }): Promise<ReconciliationItem[]> {
    const rows = await this.db
      .selectFrom('reconciliation_items')
      .selectAll()
      .where('run_id', '=', query.runId)
      .where(sql<boolean>`seq > ${query.afterSeq}`)
      .$if(query.caseStatus !== null, (qb) =>
        qb.where('case_status', '=', query.caseStatus as CaseStatus),
      )
      .orderBy(sql`seq`)
      .limit(query.limit)
      .execute();
    return rows.map(rowToItem);
  }

  async lockItem(id: string): Promise<ReconciliationItem | null> {
    const result = await sql<Selectable<ReconciliationItemsTable>>`
      select ${ITEM_COLUMNS} from ${sql.id(this.schema, 'reconciliation_items')} with (updlock, rowlock)
      where id = ${id}`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToItem(row) : null;
  }

  async resolveItem(
    id: string,
    resolution: { status: 'RESOLVED' | 'IGNORED'; resolvedBy: string; note: string; at: Date },
  ): Promise<void> {
    await this.db
      .updateTable('reconciliation_items')
      .set({
        case_status: resolution.status,
        resolved_by: resolution.resolvedBy,
        resolution_note: resolution.note,
        resolved_at: sqlDate(resolution.at),
      })
      .where('id', '=', id)
      .where('case_status', '=', 'OPEN')
      .execute();
  }

  async findTopupsByIds(ids: readonly string[]): Promise<WalletTopupView[]> {
    const views: WalletTopupView[] = [];
    for (const part of chunks([...new Set(ids)], ID_CHUNK)) {
      const rows = await this.db.selectFrom('topups').selectAll().where('id', 'in', part).execute();
      views.push(...rows.map(rowToTopupView));
    }
    return views;
  }

  async listSucceededTopups(from: Date, to: Date): Promise<WalletTopupView[]> {
    const rows = await this.db
      .selectFrom('topups')
      .selectAll()
      .where('status', '=', 'SUCCEEDED')
      .where('completed_at', '>=', sqlDate(from))
      .where('completed_at', '<', sqlDate(to))
      .orderBy('completed_at')
      .orderBy('id')
      .execute();
    return rows.map(rowToTopupView);
  }

  async findUnbalancedTransactions(): Promise<Array<{ transactionId: string; total: number }>> {
    const result = await sql<{ transaction_id: string; total: string }>`
      select top (${sql.lit(LEDGER_CHECK_LIMIT)}) transaction_id, sum(amount) as total
      from ${sql.id(this.schema, 'ledger_entries')}
      group by transaction_id
      having sum(amount) <> 0
      order by transaction_id`.execute(this.db);
    return result.rows.map((row) => ({
      transactionId: row.transaction_id,
      total: toSafeInteger(row.total),
    }));
  }

  async findBalanceMismatches(): Promise<
    Array<{ accountId: string; balance: number; ledgerTotal: number }>
  > {
    const result = await sql<{ id: string; balance: string; ledger_total: string }>`
      select top (${sql.lit(LEDGER_CHECK_LIMIT)}) a.id, a.balance, coalesce(e.total, 0) as ledger_total
      from ${sql.id(this.schema, 'accounts')} a
      left join (
        select account_id, sum(amount) as total
        from ${sql.id(this.schema, 'ledger_entries')}
        group by account_id
      ) e on e.account_id = a.id
      where a.balance <> coalesce(e.total, 0)
      order by a.id`.execute(this.db);
    return result.rows.map((row) => ({
      accountId: row.id,
      balance: toSafeInteger(row.balance),
      ledgerTotal: toSafeInteger(row.ledger_total),
    }));
  }
}
```

In `unit-of-work.ts` import `KyselyReconciliationRepository` and add `reconciliation: new KyselyReconciliationRepository(scoped, schema),` to the repositories object.

- [ ] **Step 5: Run to verify pass**

Run: `corepack pnpm test:integration reconciliation.repository` → PASS. Fix small typing details if Kysely complains (keep the behaviour). `corepack pnpm typecheck && corepack pnpm lint` → clean.

- [ ] **Step 6: Commit**

```bash
git add services/wallet
git commit -m "feat(wallet): reconciliation ports and Kysely repository

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `HttpSettlementSource`

**Files:**
- Create: `services/wallet/src/infrastructure/http-settlement-source.ts`
- Create: `services/wallet/src/infrastructure/http-settlement-source.test.ts`

**Interfaces:**
- Consumes: `SettlementSource`, `SettlementUnavailableError`, `ReconciliationTooLargeError`, `GatewayCharge`.
- Produces: `new HttpSettlementSource({ baseUrl, timeoutMs, fetchImpl? })` implementing `fetchDay(day, maxCharges)`; pages through `GET <baseUrl>/settlements?date=<day>&limit=1000[&cursor=…]` until `nextCursor` is `null`.

- [ ] **Step 1: Write the failing tests** — `http-settlement-source.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ReconciliationTooLargeError,
  SettlementUnavailableError,
} from '../application/errors.js';
import { HttpSettlementSource } from './http-settlement-source.js';

const item = (n: number, overrides: Record<string, unknown> = {}) => ({
  chargeId: `ch_${n}`,
  reference: `tp_${n}`,
  amount: 1000 * n,
  currency: 'VND',
  status: 'SUCCEEDED',
  metadata: { tenantId: 'acme' },
  completedAt: '2026-10-10T01:00:00.000Z',
  ...overrides,
});
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function build(handler: (url: URL, call: number) => Response | Promise<Response>) {
  const urls: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    return handler(url, urls.length);
  }) as typeof fetch;
  return {
    urls,
    source: new HttpSettlementSource({
      baseUrl: 'http://payment:3002',
      timeoutMs: 1000,
      fetchImpl: impl,
    }),
  };
}

describe('HttpSettlementSource', () => {
  it('reads one page and maps the charges', async () => {
    const { source, urls } = build(() =>
      json({
        date: '2026-10-10',
        items: [item(1), item(2, { status: 'FAILED', metadata: undefined })],
        nextCursor: null,
        totals: [],
      }),
    );
    expect(await source.fetchDay('2026-10-10', 100)).toEqual([
      {
        chargeId: 'ch_1',
        reference: 'tp_1',
        amount: 1000,
        currency: 'VND',
        status: 'SUCCEEDED',
        tenantId: 'acme',
      },
      {
        chargeId: 'ch_2',
        reference: 'tp_2',
        amount: 2000,
        currency: 'VND',
        status: 'FAILED',
        tenantId: null,
      },
    ]);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.pathname).toBe('/settlements');
    expect(urls[0]?.searchParams.get('date')).toBe('2026-10-10');
    expect(urls[0]?.searchParams.get('limit')).toBe('1000');
    expect(urls[0]?.searchParams.has('cursor')).toBe(false);
  });

  it('follows nextCursor across pages', async () => {
    const { source, urls } = build((_url, call) =>
      call === 1
        ? json({ items: [item(1)], nextCursor: 'abc+/=', totals: [] })
        : json({ items: [item(2)], nextCursor: null, totals: [] }),
    );
    const charges = await source.fetchDay('2026-10-10', 100);
    expect(charges.map((c) => c.chargeId)).toEqual(['ch_1', 'ch_2']);
    expect(urls[1]?.searchParams.get('cursor')).toBe('abc+/=');
  });

  it('fails with SettlementUnavailableError on HTTP errors, network errors and malformed bodies', async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => json({ error: { code: 'X' } }, 500),
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      () => json({ nope: true }),
      () => json({ items: [item(1, { amount: 1.5 })], nextCursor: null }),
      () => json({ items: [item(1, { status: 'PENDING' })], nextCursor: null }),
      () => json({ items: [item(1, { chargeId: '' })], nextCursor: null }),
      () => new Response('not json', { status: 200 }),
    ];
    for (const handler of cases) {
      await expect(build(handler).source.fetchDay('2026-10-10', 100)).rejects.toBeInstanceOf(
        SettlementUnavailableError,
      );
    }
  });

  it('fails with ReconciliationTooLargeError once the charge count passes the limit', async () => {
    const { source } = build(() =>
      json({ items: [item(1), item(2), item(3)], nextCursor: null }),
    );
    await expect(source.fetchDay('2026-10-10', 2)).rejects.toBeInstanceOf(
      ReconciliationTooLargeError,
    );
    expect(await source.fetchDay('2026-10-10', 3)).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm exec vitest run services/wallet/src/infrastructure/http-settlement-source.test.ts` → FAIL.

- [ ] **Step 3: Implement** — `http-settlement-source.ts`:

```ts
import { ReconciliationTooLargeError, SettlementUnavailableError } from '../application/errors.js';
import type { SettlementSource } from '../application/ports.js';
import type { GatewayCharge } from '../domain/reconciliation.js';

export interface HttpSettlementSourceOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Cỡ trang lớn nhất mà payment cho phép. */
const PAGE_LIMIT = 1000;

interface Page {
  items: GatewayCharge[];
  nextCursor: string | null;
}

const malformed = (what: string): SettlementUnavailableError =>
  new SettlementUnavailableError(`malformed settlement response: ${what}`);

function parseItem(raw: unknown): GatewayCharge {
  if (typeof raw !== 'object' || raw === null) throw malformed('item is not an object');
  const { chargeId, reference, amount, currency, status, metadata } = raw as Record<
    string,
    unknown
  >;
  if (typeof chargeId !== 'string' || chargeId === '') throw malformed('chargeId');
  if (typeof reference !== 'string' || reference === '') throw malformed('reference');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) throw malformed('amount');
  if (typeof currency !== 'string' || currency === '') throw malformed('currency');
  if (status !== 'SUCCEEDED' && status !== 'FAILED') throw malformed('status');
  const tenant =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>).tenantId
      : undefined;
  return {
    chargeId,
    reference,
    amount,
    currency,
    status,
    tenantId: typeof tenant === 'string' && tenant !== '' ? tenant : null,
  };
}

function parsePage(body: unknown): Page {
  if (typeof body !== 'object' || body === null) throw malformed('body is not an object');
  const { items, nextCursor } = body as { items?: unknown; nextCursor?: unknown };
  if (!Array.isArray(items)) throw malformed('items');
  if (nextCursor !== null && typeof nextCursor !== 'string') throw malformed('nextCursor');
  return { items: items.map(parseItem), nextCursor };
}

/** Đọc sao kê cuối ngày của payment (`GET /settlements`), duyệt hết các trang bằng cursor. */
export class HttpSettlementSource implements SettlementSource {
  constructor(private readonly options: HttpSettlementSourceOptions) {}

  async fetchDay(day: string, maxCharges: number): Promise<GatewayCharge[]> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const charges: GatewayCharge[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL(`${this.options.baseUrl}/settlements`);
      url.searchParams.set('date', day);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor !== null) url.searchParams.set('cursor', cursor);

      let body: unknown;
      try {
        const response = await doFetch(url, { signal: AbortSignal.timeout(this.options.timeoutMs) });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        body = await response.json();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SettlementUnavailableError(`settlement request for ${day} failed: ${message}`);
      }

      const page = parsePage(body);
      charges.push(...page.items);
      if (charges.length > maxCharges) {
        throw new ReconciliationTooLargeError(
          `settlement for ${day} has more than ${maxCharges} charges`,
        );
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return charges;
  }
}
```

- [ ] **Step 4: Run to verify pass** — the same command → PASS; `corepack pnpm lint && corepack pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add services/wallet/src/infrastructure
git commit -m "feat(wallet): HTTP settlement source for reconciliation

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `RunReconciliation` use case (+ test support)

**Files:**
- Create: `services/wallet/src/test-support-reconciliation.ts`
- Create: `services/wallet/src/application/run-reconciliation.ts`
- Create: `services/wallet/src/application/run-reconciliation.integration.test.ts`
- Create: `services/wallet/src/application/run-reconciliation.ledger.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4 (`ReconciliationRepository`, `SettlementSource`), `ApplyPaymentResult.execute`.
- Produces:
  - `RunHandle = { tenant: TenantId; runId: string; day: string }`
  - `new RunReconciliation({ uow, settlement, applyPayment, clock, ids, log, options: { autofix: boolean; maxItems: number } })` with
    `begin({ tenant, day, triggeredBy }): Promise<RunHandle | null>` (validates the day, throws `InvalidReconciliationError`; `null` when a SCHEDULED run for that day already exists),
    `finish(handle): Promise<ReconciliationRun>` (never throws for expected failures; marks the run `FAILED` with a reason),
    `execute(input): Promise<ReconciliationRun | null>` (= `begin` then `finish`).
  - Test support: `FakeSettlement` (`set(day, charges)`, `failWith`, `calls`), `chargeFor(seeded, overrides)`, `seedSucceededTopup(h, options)`, `startDay(h)`.

- [ ] **Step 1: Test support** — `services/wallet/src/test-support-reconciliation.ts`:

```ts
import { ApplyPaymentResult } from './application/apply-payment-result.js';
import { ReconciliationTooLargeError } from './application/errors.js';
import type { SettlementSource } from './application/ports.js';
import type { GatewayCharge } from './domain/reconciliation.js';
import { seedTopup, silentLogger, type Harness, type SeededTopup } from './test-support.js';

/** Sao kê giả: trả charge đã đặt theo ngày, hoặc ném lỗi đã chọn. */
export class FakeSettlement implements SettlementSource {
  readonly calls: string[] = [];
  failWith: Error | undefined;
  readonly #days = new Map<string, GatewayCharge[]>();

  set(day: string, charges: GatewayCharge[]): this {
    this.#days.set(day, charges);
    return this;
  }

  async fetchDay(day: string, maxCharges: number): Promise<GatewayCharge[]> {
    this.calls.push(day);
    if (this.failWith) throw this.failWith;
    const charges = this.#days.get(day) ?? [];
    if (charges.length > maxCharges) {
      throw new ReconciliationTooLargeError(
        `settlement for ${day} has more than ${maxCharges} charges`,
      );
    }
    return charges;
  }
}

/** Charge SUCCEEDED khớp hoàn toàn với lần nạp đã dựng; ghi đè từng trường để tạo lệch. */
export const chargeFor = (
  seeded: SeededTopup,
  overrides: Partial<GatewayCharge> = {},
): GatewayCharge => ({
  chargeId: seeded.chargeId,
  reference: seeded.topupId,
  amount: seeded.amount,
  currency: seeded.currency,
  status: 'SUCCEEDED',
  tenantId: seeded.tenant.value,
  ...overrides,
});

/** Lần nạp đã SUCCEEDED thật (qua `ApplyPaymentResult`), số dư ví đã được cộng. */
export async function seedSucceededTopup(
  h: Harness,
  options: Parameters<typeof seedTopup>[1] = {},
): Promise<SeededTopup> {
  const seeded = await seedTopup(h, { ...options, state: 'PENDING' });
  const outcome = await new ApplyPaymentResult({
    uow: h.uow,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
  }).execute({
    tenant: seeded.tenant,
    eventId: `evt_seed_${seeded.topupId}`,
    type: 'charge.succeeded',
    chargeId: seeded.chargeId,
    reference: seeded.topupId,
    amount: seeded.amount,
    currency: seeded.currency,
  });
  if (outcome !== 'APPLIED') throw new Error(`could not settle seeded topup: ${outcome}`);
  return seeded;
}

let dayCounter = 0;

/** Mỗi test một ngày riêng (các test dùng chung database) và đặt đồng hồ vào 10:00 UTC của ngày đó. */
export function startDay(h: Harness): string {
  const day = new Date(Date.UTC(2027, 0, 1 + ++dayCounter)).toISOString().slice(0, 10);
  h.clock.set(`${day}T10:00:00.000Z`);
  return day;
}
```

- [ ] **Step 2: Write the failing tests** — `application/run-reconciliation.integration.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { InvalidReconciliationError } from '../domain/errors.js';
import { previousDay } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import {
  createHarness,
  expectLedgerInvariants,
  seedTopup,
  silentLogger,
  type Harness,
} from '../test-support.js';
import {
  FakeSettlement,
  chargeFor,
  seedSucceededTopup,
  startDay,
} from '../test-support-reconciliation.js';
import { ApplyPaymentResult } from './apply-payment-result.js';
import { SettlementUnavailableError } from './errors.js';
import { RunReconciliation, type RunReconciliationDeps } from './run-reconciliation.js';

let h: Harness;
let settlement: FakeSettlement;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  settlement = new FakeSettlement();
});
afterEach(async () => {
  await expectLedgerInvariants(h, h.acme);
  await expectLedgerInvariants(h, h.beta);
});

function build(
  options: Partial<RunReconciliationDeps['options']> = {},
  applyPayment?: RunReconciliationDeps['applyPayment'],
): RunReconciliation {
  return new RunReconciliation({
    uow: h.uow,
    settlement,
    applyPayment:
      applyPayment ??
      new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger }),
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    options: { autofix: true, maxItems: 1000, ...options },
  });
}

const itemsOf = (tenant: TenantId, runId: string) =>
  h.uow.run(tenant, ({ reconciliation }) =>
    reconciliation.listItems({ runId, caseStatus: null, afterSeq: 0, limit: 100 }),
  );
const walletBalance = async (tenant: TenantId, customer: string): Promise<number> =>
  Number(
    (
      await h.db
        .withSchema(`t_${tenant.value}`)
        .selectFrom('accounts')
        .select('balance')
        .where('customer_id', '=', customer)
        .where('kind', '=', 'WALLET')
        .executeTakeFirstOrThrow()
    ).balance,
  );
const topupStatus = async (tenant: TenantId, topupId: string): Promise<string> =>
  (
    await h.db
      .withSchema(`t_${tenant.value}`)
      .selectFrom('topups')
      .select('status')
      .where('id', '=', topupId)
      .executeTakeFirstOrThrow()
  ).status;
const ledgerCount = async (tenant: TenantId, topupId: string): Promise<number> =>
  (
    await h.db
      .withSchema(`t_${tenant.value}`)
      .selectFrom('ledger_transactions')
      .select('id')
      .where('business_key', '=', `topup:${topupId}`)
      .execute()
  ).length;

const run = (day: string, tenant = h.acme, reconciliation = build()) =>
  reconciliation.execute({ tenant, day, triggeredBy: 'MANUAL' });

describe('a clean day', () => {
  it('completes with no items and stores informational totals', async () => {
    const day = startDay(h);
    const a = await seedSucceededTopup(h, { amount: 100000 });
    const b = await seedSucceededTopup(h, { amount: 50000 });
    settlement.set(day, [chargeFor(a), chargeFor(b)]);

    const result = await run(day);

    expect(result).toMatchObject({
      day,
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      itemCount: 0,
      gatewayTotals: { VND: 150000 },
      walletTotals: { VND: 150000 },
    });
    expect(settlement.calls).toEqual([day, previousDay(day)]);
    expect(await itemsOf(h.acme, result!.id)).toEqual([]);
  });
});

describe('MISSING_AT_WALLET (lost webhook)', () => {
  it('credits the wallet once, through the normal topup path, and records an AUTO_APPLIED item', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);

    const result = await run(day);

    const items = await itemsOf(h.acme, result!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'MISSING_AT_WALLET',
      action: 'AUTO_APPLIED',
      caseStatus: 'RESOLVED',
      resolvedBy: 'system',
      topupId: topup.topupId,
      chargeId: topup.chargeId,
      amountGateway: 90000,
      amountWallet: 90000,
      currency: 'VND',
    });
    expect(await walletBalance(h.acme, topup.customer)).toBe(90000);
    expect(await topupStatus(h.acme, topup.topupId)).toBe('SUCCEEDED');
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);
  });

  it('also credits a topup that was never submitted (REQUESTED) and one that FAILED as PAYMENT_UNAVAILABLE', async () => {
    const day = startDay(h);
    const requested = await seedTopup(h, { state: 'REQUESTED', amount: 10000 });
    const unavailable = await seedTopup(h, { state: 'FAILED_UNAVAILABLE', amount: 20000 });
    settlement.set(day, [
      chargeFor(requested, { chargeId: 'ch_gateway_only_1' }),
      chargeFor(unavailable, { chargeId: 'ch_gateway_only_2' }),
    ]);

    const result = await run(day);

    expect((await itemsOf(h.acme, result!.id)).map((i) => [i.kind, i.action])).toEqual([
      ['MISSING_AT_WALLET', 'AUTO_APPLIED'],
      ['MISSING_AT_WALLET', 'AUTO_APPLIED'],
    ]);
    expect(await walletBalance(h.acme, requested.customer)).toBe(10000);
    expect(await walletBalance(h.acme, unavailable.customer)).toBe(20000);
  });

  it('only reports when RECONCILE_AUTOFIX is off', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);

    const result = await run(day, h.acme, build({ autofix: false }));

    const items = await itemsOf(h.acme, result!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ action: 'NONE', caseStatus: 'OPEN', resolvedBy: null });
    expect(await walletBalance(h.acme, topup.customer)).toBe(0);
    expect(await topupStatus(h.acme, topup.topupId)).toBe('PENDING');
  });

  it('keeps a failed auto-credit as an open FAILED_AUTOFIX case', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);

    const result = await run(
      day,
      h.acme,
      build({}, {
        execute: () => {
          throw new Error('database exploded');
        },
      }),
    );

    expect(result?.status).toBe('COMPLETED');
    const [item] = await itemsOf(h.acme, result!.id);
    expect(item).toMatchObject({
      action: 'FAILED_AUTOFIX',
      caseStatus: 'OPEN',
      detail: { autofix: 'error', error: 'database exploded' },
    });
  });

  it('credits exactly once when two runs race on the same day', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 70000 });
    settlement.set(day, [chargeFor(topup)]);

    const [first, second] = await Promise.all([run(day), run(day)]);

    expect(first?.status).toBe('COMPLETED');
    expect(second?.status).toBe('COMPLETED');
    expect(await walletBalance(h.acme, topup.customer)).toBe(70000);
    expect(await ledgerCount(h.acme, topup.topupId)).toBe(1);
    // Lượt đến sau có thể thấy lần nạp đã SUCCEEDED (không có dòng lệch) hoặc còn PENDING (ghi bù trượt vì webhook/lượt kia đã ghi trước).
    const actions = [
      ...(await itemsOf(h.acme, first!.id)),
      ...(await itemsOf(h.acme, second!.id)),
    ].map((i) => i.action);
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.every((action) => action === 'AUTO_APPLIED')).toBe(true);
  });
});

describe('discrepancies that need a human', () => {
  it('reports UNKNOWN_CHARGE, AMOUNT_MISMATCH and STATUS_MISMATCH without touching the ledger', async () => {
    const day = startDay(h);
    const wrongAmount = await seedTopup(h, { state: 'PENDING', amount: 30000 });
    const ghostCharge = {
      chargeId: 'ch_ghost',
      reference: 'tp_ghost',
      amount: 5000,
      currency: 'VND',
      status: 'SUCCEEDED',
      tenantId: 'acme',
    } as const;
    const settled = await seedSucceededTopup(h, { amount: 40000 });
    settlement.set(day, [
      chargeFor(wrongAmount, { amount: 31000 }),
      ghostCharge,
      chargeFor(settled, { status: 'FAILED' }),
    ]);

    const result = await run(day);

    const items = await itemsOf(h.acme, result!.id);
    expect(items.map((i) => [i.kind, i.caseStatus, i.action])).toEqual([
      ['AMOUNT_MISMATCH', 'OPEN', 'NONE'],
      ['UNKNOWN_CHARGE', 'OPEN', 'NONE'],
      ['STATUS_MISMATCH', 'OPEN', 'NONE'],
    ]);
    expect(items[0]).toMatchObject({ amountGateway: 31000, amountWallet: 30000 });
    expect(items[1]).toMatchObject({ chargeId: 'ch_ghost', topupId: null });
    expect(await walletBalance(h.acme, wrongAmount.customer)).toBe(0);
    expect(await walletBalance(h.acme, settled.customer)).toBe(40000);
  });

  it('reports MISSING_AT_GATEWAY unless the gateway listed the charge on the previous day', async () => {
    const day = startDay(h);
    const lost = await seedSucceededTopup(h);
    const early = await seedSucceededTopup(h);
    settlement.set(previousDay(day), [chargeFor(early)]);

    const result = await run(day);

    const items = await itemsOf(h.acme, result!.id);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'MISSING_AT_GATEWAY',
      topupId: lost.topupId,
      amountGateway: null,
      amountWallet: lost.amount,
    });
  });

  it('ignores charges that belong to another tenant or carry no tenant', async () => {
    const day = startDay(h);
    const topup = await seedSucceededTopup(h, { tenant: h.beta });
    settlement.set(day, [
      chargeFor(topup),
      { chargeId: 'ch_anon', reference: 'tp_anon', amount: 1, currency: 'VND', status: 'SUCCEEDED', tenantId: null },
    ]);

    const acme = await run(day, h.acme);
    const beta = await run(day, h.beta);

    expect(acme).toMatchObject({ status: 'COMPLETED', itemCount: 0, gatewayTotals: {} });
    expect(beta).toMatchObject({ status: 'COMPLETED', itemCount: 0, gatewayTotals: { VND: topup.amount } });
  });
});

describe('failures', () => {
  it('fails the run, creates no items and credits nothing when the gateway is unavailable', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup)]);
    settlement.failWith = new SettlementUnavailableError('gateway down');

    const result = await run(day);

    expect(result).toMatchObject({ status: 'FAILED', failureReason: 'gateway down', itemCount: 0 });
    expect(result?.finishedAt).not.toBeNull();
    expect(await itemsOf(h.acme, result!.id)).toEqual([]);
    expect(await walletBalance(h.acme, topup.customer)).toBe(0);
  });

  it('fails the run when the settlement has more charges than RECONCILE_MAX_ITEMS', async () => {
    const day = startDay(h);
    const a = await seedSucceededTopup(h);
    const b = await seedSucceededTopup(h);
    settlement.set(day, [chargeFor(a), chargeFor(b)]);

    const result = await run(day, h.acme, build({ maxItems: 1 }));

    expect(result?.status).toBe('FAILED');
    expect(result?.failureReason).toMatch(/more than 1 charges/);
  });

  it('fails the run when there are more discrepancies than RECONCILE_MAX_ITEMS', async () => {
    const day = startDay(h);
    await seedSucceededTopup(h);
    await seedSucceededTopup(h);

    const result = await run(day, h.acme, build({ maxItems: 1 }));

    expect(result?.status).toBe('FAILED');
    expect(result?.failureReason).toMatch(/2 discrepancies/);
  });
});

describe('runs', () => {
  it('are immutable: a re-run creates a new run and leaves the old items alone', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 25000 });
    settlement.set(day, [chargeFor(topup)]);

    const first = await run(day);
    const before = await itemsOf(h.acme, first!.id);
    const second = await run(day);

    expect(second?.id).not.toBe(first?.id);
    expect(await itemsOf(h.acme, first!.id)).toEqual(before);
    expect(await itemsOf(h.acme, second!.id)).toEqual([]);
    expect(await h.uow.run(h.acme, ({ reconciliation }) => reconciliation.findRun(first!.id))).toMatchObject({
      status: 'COMPLETED',
      itemCount: 1,
    });
  });

  it('rejects a malformed, impossible or future day', async () => {
    const day = startDay(h);
    const tomorrow = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    for (const bad of [tomorrow, '2027-02-30', 'yesterday']) {
      await expect(
        build().begin({ tenant: h.acme, day: bad, triggeredBy: 'MANUAL' }),
      ).rejects.toBeInstanceOf(InvalidReconciliationError);
    }
  });

  it('refuses a second SCHEDULED run for the same day (begin returns null)', async () => {
    const day = startDay(h);
    const reconciliation = build();
    expect(await reconciliation.begin({ tenant: h.acme, day, triggeredBy: 'SCHEDULED' })).not.toBeNull();
    expect(await reconciliation.begin({ tenant: h.acme, day, triggeredBy: 'SCHEDULED' })).toBeNull();
    expect(await reconciliation.begin({ tenant: h.acme, day, triggeredBy: 'MANUAL' })).not.toBeNull();
  });
});
```

And `application/run-reconciliation.ledger.integration.test.ts` (own database because it tampers with the ledger; no ledger-invariant check afterwards):

```ts
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, silentLogger, type Harness } from '../test-support.js';
import {
  FakeSettlement,
  chargeFor,
  seedSucceededTopup,
  startDay,
} from '../test-support-reconciliation.js';
import { ApplyPaymentResult } from './apply-payment-result.js';
import { RunReconciliation } from './run-reconciliation.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe('ledger integrity check', () => {
  it('reports an unbalanced transaction and drifting balances, and nothing on a clean tenant', async () => {
    const settlement = new FakeSettlement();
    const build = () =>
      new RunReconciliation({
        uow: h.uow,
        settlement,
        applyPayment: new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger }),
        clock: h.clock,
        ids: h.ids,
        log: silentLogger,
        options: { autofix: true, maxItems: 1000 },
      });

    const cleanDay = startDay(h);
    const topup = await seedSucceededTopup(h, { amount: 60000 });
    settlement.set(cleanDay, [chargeFor(topup)]);
    const clean = await build().execute({ tenant: h.acme, day: cleanDay, triggeredBy: 'MANUAL' });
    expect(clean).toMatchObject({ status: 'COMPLETED', itemCount: 0 });

    const walletId = (
      await h.db
        .withSchema('t_acme')
        .selectFrom('accounts')
        .select('id')
        .where('customer_id', '=', topup.customer)
        .executeTakeFirstOrThrow()
    ).id;
    await sql`insert into ${sql.id('t_acme', 'ledger_transactions')} (id, business_key, kind, created_at)
      values ('tx_bad', 'bad:1', 'TOPUP', cast(sysutcdatetime() as datetime2(3)))`.execute(h.db);
    await sql`insert into ${sql.id('t_acme', 'ledger_entries')} (transaction_id, account_id, amount, created_at)
      values ('tx_bad', 'system:MERCHANT:VND', 7, cast(sysutcdatetime() as datetime2(3)))`.execute(h.db);
    await sql`update ${sql.id('t_acme', 'accounts')} set balance = balance + 5 where id = ${walletId}`.execute(h.db);

    const badDay = startDay(h);
    settlement.set(badDay, [chargeFor(topup)]);
    const result = await build().execute({ tenant: h.acme, day: badDay, triggeredBy: 'MANUAL' });

    expect(result).toMatchObject({ status: 'COMPLETED', itemCount: 3 });
    const items = await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.listItems({ runId: result!.id, caseStatus: null, afterSeq: 0, limit: 10 }),
    );
    expect(items.map((i) => i.kind)).toEqual([
      'LEDGER_UNBALANCED',
      'BALANCE_MISMATCH',
      'BALANCE_MISMATCH',
    ]);
    expect(items[0]).toMatchObject({
      chargeId: null,
      topupId: null,
      detail: { transactionId: 'tx_bad', total: 7 },
    });
    const drift = Object.fromEntries(
      items.slice(1).map((i) => [(i.detail as { accountId: string }).accountId, i.detail]),
    );
    expect(drift[walletId]).toEqual({ accountId: walletId, balance: 60005, ledgerTotal: 60000 });
    expect(drift['system:MERCHANT:VND']).toEqual({
      accountId: 'system:MERCHANT:VND',
      balance: 0,
      ledgerTotal: 7,
    });
    expect(items.every((i) => i.caseStatus === 'OPEN' && i.action === 'NONE')).toBe(true);
  });
});
```

(The ledger transactions/entries triggers are `instead of update, delete`; an `insert` is allowed, which is how the tamper rows get in. The test uses its own database so the broken ledger cannot affect other tests. If the wallet account of the first topup is credited from `system:GATEWAY:VND`, the clean run still has no drift.)

- [ ] **Step 3: Run to verify failure**

Run: `corepack pnpm test:integration run-reconciliation` → FAIL (use case missing).

- [ ] **Step 4: Implement** — `application/run-reconciliation.ts`:

```ts
import {
  classifyCharge,
  dayBounds,
  findMissingAtGateway,
  parseReconciliationDay,
  previousDay,
  totalsByCurrency,
  type AutofixAction,
  type Discrepancy,
} from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { ApplyPaymentResult } from './apply-payment-result.js';
import { ReconciliationTooLargeError } from './errors.js';
import type {
  Clock,
  IdGenerator,
  Logger,
  NewReconciliationItem,
  ReconciliationRun,
  RunTrigger,
  SettlementSource,
  TenantUnitOfWork,
} from './ports.js';

export interface RunHandle {
  tenant: TenantId;
  runId: string;
  day: string;
}

export interface RunReconciliationDeps {
  uow: TenantUnitOfWork;
  settlement: SettlementSource;
  /** Đường nạp tiền bình thường (chống trùng sẵn); đối soát không tự ghi sổ cách nào khác. */
  applyPayment: Pick<ApplyPaymentResult, 'execute'>;
  clock: Clock;
  ids: IdGenerator;
  log: Logger;
  options: { autofix: boolean; maxItems: number };
}

interface GatewayCheck {
  discrepancies: Discrepancy[];
  gatewayTotals: Record<string, number>;
  walletTotals: Record<string, number>;
}

interface Autofix {
  action: AutofixAction;
  detail: Record<string, unknown>;
}

/** Một lượt đối soát cho một tenant và một ngày UTC. Mặc định chỉ đọc; chỉ tự ghi bù `MISSING_AT_WALLET`. */
export class RunReconciliation {
  constructor(private readonly deps: RunReconciliationDeps) {}

  /** Tạo lượt `RUNNING`; `null` nếu lượt `SCHEDULED` của ngày đó đã có. Ném `InvalidReconciliationError` khi ngày sai. */
  async begin(input: {
    tenant: TenantId;
    day: string;
    triggeredBy: RunTrigger;
  }): Promise<RunHandle | null> {
    const now = this.deps.clock.now();
    const day = parseReconciliationDay(input.day, now);
    const runId = this.deps.ids.eventId();
    const started = await this.deps.uow.run(input.tenant, ({ reconciliation }) =>
      reconciliation.startRun({ id: runId, day, triggeredBy: input.triggeredBy, startedAt: now }),
    );
    return started ? { tenant: input.tenant, runId, day } : null;
  }

  async execute(input: {
    tenant: TenantId;
    day: string;
    triggeredBy: RunTrigger;
  }): Promise<ReconciliationRun | null> {
    const handle = await this.begin(input);
    return handle === null ? null : this.finish(handle);
  }

  /** Chạy các phép kiểm tra và đóng lượt. Lỗi dự kiến (sao kê, quá lớn, lỗi bất ngờ) đóng lượt `FAILED`, không ném. */
  async finish(handle: RunHandle): Promise<ReconciliationRun> {
    const { tenant, runId, day } = handle;
    try {
      const ledger = await this.checkLedger(tenant);
      const gateway = await this.checkGateway(tenant, day);
      const found = [...ledger, ...gateway.discrepancies];
      if (found.length > this.deps.options.maxItems) {
        throw new ReconciliationTooLargeError(
          `found ${found.length} discrepancies, more than the limit of ${this.deps.options.maxItems}`,
        );
      }

      const items: NewReconciliationItem[] = [];
      for (const discrepancy of found) {
        const fix =
          discrepancy.kind === 'MISSING_AT_WALLET' && this.deps.options.autofix
            ? await this.autofix(tenant, runId, discrepancy)
            : null;
        items.push({
          id: this.deps.ids.eventId(),
          ...discrepancy,
          action: fix?.action ?? 'NONE',
          detail: { ...discrepancy.detail, ...fix?.detail },
        });
      }

      const finishedAt = this.deps.clock.now();
      await this.deps.uow.run(tenant, ({ reconciliation }) =>
        reconciliation.completeRun(runId, {
          gatewayTotals: gateway.gatewayTotals,
          walletTotals: gateway.walletTotals,
          items,
          finishedAt,
        }),
      );
      this.report(tenant, runId, day, items);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unexpected error';
      this.deps.log.error({ err: error, tenantId: tenant.value, runId, day }, 'reconciliation run failed');
      await this.deps.uow.run(tenant, ({ reconciliation }) =>
        reconciliation.failRun(runId, reason, this.deps.clock.now()),
      );
    }
    const run = await this.deps.uow.run(tenant, ({ reconciliation }) => reconciliation.findRun(runId));
    if (run === null) throw new Error(`reconciliation run ${runId} disappeared`);
    return run;
  }

  private async checkLedger(tenant: TenantId): Promise<Discrepancy[]> {
    const { unbalanced, drift } = await this.deps.uow.run(tenant, async ({ reconciliation }) => ({
      unbalanced: await reconciliation.findUnbalancedTransactions(),
      drift: await reconciliation.findBalanceMismatches(),
    }));
    const none = { chargeId: null, topupId: null, amountGateway: null, amountWallet: null, currency: null };
    return [
      ...unbalanced.map((u): Discrepancy => ({
        ...none,
        kind: 'LEDGER_UNBALANCED',
        detail: { transactionId: u.transactionId, total: u.total },
      })),
      ...drift.map((d): Discrepancy => ({
        ...none,
        kind: 'BALANCE_MISMATCH',
        detail: { accountId: d.accountId, balance: d.balance, ledgerTotal: d.ledgerTotal },
      })),
    ];
  }

  private async checkGateway(tenant: TenantId, day: string): Promise<GatewayCheck> {
    const max = this.deps.options.maxItems;
    // Webhook có thể đến sau nửa đêm: charge hoàn tất ngày D-1 nhưng wallet ghi nhận ngày D. Chỉ dùng D-1 để tra cứu.
    const today = await this.deps.settlement.fetchDay(day, max);
    const before = await this.deps.settlement.fetchDay(previousDay(day), max);
    const mine = today.filter((charge) => charge.tenantId === tenant.value);

    const topups = await this.deps.uow.run(tenant, ({ reconciliation }) =>
      reconciliation.findTopupsByIds(mine.map((charge) => charge.reference)),
    );
    const byId = new Map(topups.map((topup) => [topup.id, topup]));
    const discrepancies: Discrepancy[] = [];
    for (const charge of mine) {
      const discrepancy = classifyCharge(charge, byId.get(charge.reference) ?? null);
      if (discrepancy !== null) discrepancies.push(discrepancy);
    }

    const { from, to } = dayBounds(day);
    const succeeded = await this.deps.uow.run(tenant, ({ reconciliation }) =>
      reconciliation.listSucceededTopups(from, to),
    );
    const known = new Set([...today, ...before].map((charge) => charge.chargeId));
    discrepancies.push(...findMissingAtGateway(succeeded, known));

    return {
      discrepancies,
      gatewayTotals: totalsByCurrency(mine.filter((charge) => charge.status === 'SUCCEEDED')),
      walletTotals: totalsByCurrency(succeeded),
    };
  }

  /** Ghi bù một lần nạp mà payment đã xác nhận thành công. Mỗi lần là một transaction riêng; lỗi không lan sang dòng khác. */
  private async autofix(tenant: TenantId, runId: string, d: Discrepancy): Promise<Autofix> {
    if (d.chargeId === null || d.topupId === null || d.amountGateway === null || d.currency === null) {
      return { action: 'FAILED_AUTOFIX', detail: { autofix: 'incomplete discrepancy' } };
    }
    const topupId = d.topupId;
    try {
      // eventId theo lượt: một lần thử thất bại trước đó không chặn lượt sau; chống ghi hai lần nhờ business key `topup:<id>`.
      const outcome = await this.deps.applyPayment.execute({
        tenant,
        eventId: `reconcile:${runId}:${d.chargeId}`,
        type: 'charge.succeeded',
        chargeId: d.chargeId,
        reference: topupId,
        amount: d.amountGateway,
        currency: d.currency,
      });
      if (outcome === 'APPLIED') return { action: 'AUTO_APPLIED', detail: { autofix: 'APPLIED' } };
      if (outcome === 'IGNORED') {
        // Webhook thật đến trước: lần nạp đã SUCCEEDED thì coi như đã xử lý xong.
        const now = await this.deps.uow.run(tenant, ({ topups }) => topups.findById(topupId));
        if (now?.toProps().status === 'SUCCEEDED') {
          return { action: 'AUTO_APPLIED', detail: { autofix: 'already settled' } };
        }
      }
      return { action: 'FAILED_AUTOFIX', detail: { autofix: outcome } };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unexpected error';
      return { action: 'FAILED_AUTOFIX', detail: { autofix: 'error', error: message.slice(0, 200) } };
    }
  }

  private report(tenant: TenantId, runId: string, day: string, items: readonly NewReconciliationItem[]): void {
    for (const item of items) {
      const details = {
        tenantId: tenant.value,
        runId,
        day,
        kind: item.kind,
        chargeId: item.chargeId,
        topupId: item.topupId,
      };
      if (item.kind === 'LEDGER_UNBALANCED' || item.kind === 'BALANCE_MISMATCH') {
        this.deps.log.error({ ...details, detail: item.detail }, 'ledger integrity check failed');
      } else if (item.action === 'AUTO_APPLIED') {
        this.deps.log.info(details, 'reconciliation credited a topup whose webhook was lost');
      } else {
        this.deps.log.warn({ ...details, action: item.action }, 'reconciliation found a discrepancy that needs a human');
      }
    }
  }
}
```

- [ ] **Step 5: Run to verify pass**

Run: `corepack pnpm test:integration run-reconciliation` → PASS. If the race test shows a SQL deadlock between the two concurrent `ApplyPaymentResult` calls, the cause is lock order inside `ApplyPaymentResult` (topup row first, then accounts) which is the same for both — report it rather than weakening the test. `corepack pnpm lint && corepack pnpm typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add services/wallet/src
git commit -m "feat(wallet): RunReconciliation (ledger checks, gateway comparison, safe auto-credit)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Daily scheduler (`ScheduleDailyReconciliation`)

**Files:**
- Create: `services/wallet/src/application/schedule-daily-reconciliation.ts`
- Create: `services/wallet/src/application/schedule-daily-reconciliation.integration.test.ts`

**Interfaces:**
- Consumes: `RunReconciliation.execute`, `ReconciliationRepository.failStaleRuns` / `scheduledRunsFor`, `yesterdayUtc`.
- Produces: `ScheduleDailyReconciliation({ uow, run, clock, log, options: { atUtcHour, maxAttempts } }).execute(tenant): Promise<ScheduleOutcome>` with `ScheduleOutcome = 'TOO_EARLY' | 'DONE' | 'IN_PROGRESS' | 'GAVE_UP' | 'WAITING' | 'SKIPPED' | 'RAN'`; exported constants `STALE_RUN_MINUTES = 30`, `RETRY_AFTER_MINUTES = 15`.

Rules: before `atUtcHour` UTC → `TOO_EARLY`. Day = yesterday UTC. Mark `RUNNING` scheduled runs older than 30 min as `FAILED` ("abandoned…"). Then: a `COMPLETED` scheduled run exists → `DONE`; a `RUNNING` one → `IN_PROGRESS`; `failed >= maxAttempts` → `GAVE_UP` (logged once); last failure younger than 15 min → `WAITING`; otherwise run it (`RAN`, or `SKIPPED` if another worker won the unique index). `DONE` and `GAVE_UP` are remembered in memory per tenant+day so the 500 ms worker tick does no database work afterwards.

- [ ] **Step 1: Write the failing tests** — `schedule-daily-reconciliation.integration.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, silentLogger, type Harness } from '../test-support.js';
import { FakeSettlement } from '../test-support-reconciliation.js';
import { ApplyPaymentResult } from './apply-payment-result.js';
import { SettlementUnavailableError } from './errors.js';
import { RunReconciliation } from './run-reconciliation.js';
import {
  ScheduleDailyReconciliation,
  RETRY_AFTER_MINUTES,
} from './schedule-daily-reconciliation.js';

let h: Harness;
let settlement: FakeSettlement;
let dayCounter = 0;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  settlement = new FakeSettlement();
});

/** Mỗi test một ngày riêng; trả về ngày "hôm qua" mà bộ lập lịch sẽ đối soát. */
function today(hour = 3): { now: string; yesterday: string } {
  const base = Date.UTC(2028, 0, 10 + ++dayCounter);
  const now = new Date(base + hour * 3_600_000).toISOString();
  h.clock.set(now);
  return { now, yesterday: new Date(base - 86_400_000).toISOString().slice(0, 10) };
}

function build(options = { atUtcHour: 2, maxAttempts: 2 }) {
  const run = new RunReconciliation({
    uow: h.uow,
    settlement,
    applyPayment: new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger }),
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    options: { autofix: true, maxItems: 1000 },
  });
  return new ScheduleDailyReconciliation({ uow: h.uow, run, clock: h.clock, log: silentLogger, options });
}

const runsFor = (day: string) =>
  h.db
    .withSchema('t_acme')
    .selectFrom('reconciliation_runs')
    .selectAll()
    .where('run_day', '=', day)
    .orderBy('started_at')
    .execute();

describe('ScheduleDailyReconciliation', () => {
  it('waits until RECONCILE_AT_UTC_HOUR', async () => {
    const { yesterday } = today(1);
    expect(await build().execute(h.acme)).toBe('TOO_EARLY');
    expect(settlement.calls).toEqual([]);
    expect(await runsFor(yesterday)).toEqual([]);
  });

  it("reconciles yesterday once, even after a restart", async () => {
    const { yesterday } = today(3);
    const scheduler = build();

    expect(await scheduler.execute(h.acme)).toBe('RAN');
    const calls = settlement.calls.length;
    expect(settlement.calls[0]).toBe(yesterday);
    expect(await runsFor(yesterday)).toMatchObject([{ triggered_by: 'SCHEDULED', status: 'COMPLETED' }]);

    expect(await scheduler.execute(h.acme)).toBe('DONE');
    expect(await build().execute(h.acme)).toBe('DONE');
    expect(settlement.calls).toHaveLength(calls);
    expect(await runsFor(yesterday)).toHaveLength(1);
  });

  it('retries a failed run no sooner than 15 minutes later and gives up after RECONCILE_MAX_ATTEMPTS', async () => {
    const { yesterday } = today(3);
    const scheduler = build({ atUtcHour: 2, maxAttempts: 2 });
    settlement.failWith = new SettlementUnavailableError('gateway down');

    expect(await scheduler.execute(h.acme)).toBe('RAN');
    expect(await scheduler.execute(h.acme)).toBe('WAITING');

    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    expect(await scheduler.execute(h.acme)).toBe('RAN');

    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    settlement.failWith = undefined;
    expect(await scheduler.execute(h.acme)).toBe('GAVE_UP');
    expect(await scheduler.execute(h.acme)).toBe('GAVE_UP');
    expect((await runsFor(yesterday)).map((r) => r.status)).toEqual(['FAILED', 'FAILED']);
  });

  it('recovers when the gateway comes back before the attempts run out', async () => {
    const { yesterday } = today(3);
    const scheduler = build({ atUtcHour: 2, maxAttempts: 3 });
    settlement.failWith = new SettlementUnavailableError('gateway down');
    expect(await scheduler.execute(h.acme)).toBe('RAN');

    settlement.failWith = undefined;
    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    expect(await scheduler.execute(h.acme)).toBe('RAN');
    expect(await scheduler.execute(h.acme)).toBe('DONE');
    expect((await runsFor(yesterday)).map((r) => r.status)).toEqual(['FAILED', 'COMPLETED']);
  });

  it('abandons a RUNNING run left behind by a crashed worker, then retries after the wait', async () => {
    const { yesterday } = today(3);
    await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.startRun({
        id: 'crashed',
        day: yesterday,
        triggeredBy: 'SCHEDULED',
        startedAt: new Date(h.clock.now().getTime() - 31 * 60_000),
      }),
    );
    const scheduler = build();

    expect(await scheduler.execute(h.acme)).toBe('WAITING');
    expect((await runsFor(yesterday))[0]).toMatchObject({
      id: 'crashed',
      status: 'FAILED',
    });
    expect((await runsFor(yesterday))[0]?.failure_reason).toMatch(/abandoned/);

    h.clock.advance((RETRY_AFTER_MINUTES + 1) * 60_000);
    expect(await scheduler.execute(h.acme)).toBe('RAN');
  });

  it('leaves a fresh RUNNING run to the worker that owns it', async () => {
    const { yesterday } = today(3);
    await h.uow.run(h.acme, ({ reconciliation }) =>
      reconciliation.startRun({ id: 'live', day: yesterday, triggeredBy: 'SCHEDULED', startedAt: h.clock.now() }),
    );
    expect(await build().execute(h.acme)).toBe('IN_PROGRESS');
    expect(settlement.calls).toEqual([]);
  });

  it('starts only one run when two workers tick at the same time', async () => {
    const { yesterday } = today(3);
    const outcomes = await Promise.all([build().execute(h.acme), build().execute(h.acme)]);

    expect(outcomes.filter((o) => o === 'RAN')).toHaveLength(1);
    expect(outcomes.filter((o) => o !== 'RAN')[0]).toMatch(/^(SKIPPED|IN_PROGRESS|DONE)$/);
    expect(await runsFor(yesterday)).toHaveLength(1);
  });

  it('treats tenants independently', async () => {
    const { yesterday } = today(3);
    const scheduler = build();
    expect(await scheduler.execute(h.acme)).toBe('RAN');
    expect(await scheduler.execute(h.beta)).toBe('RAN');
    const beta = await h.db.withSchema('t_beta').selectFrom('reconciliation_runs').select('status').where('run_day', '=', yesterday).execute();
    expect(beta).toEqual([{ status: 'COMPLETED' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm test:integration schedule-daily-reconciliation` → FAIL (module missing).

- [ ] **Step 3: Implement** — `application/schedule-daily-reconciliation.ts`:

```ts
import { yesterdayUtc } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { Clock, Logger, TenantUnitOfWork } from './ports.js';
import type { RunReconciliation } from './run-reconciliation.js';

/** Lượt `RUNNING` quá hạn này coi như worker đã chết giữa chừng. */
export const STALE_RUN_MINUTES = 30;
/** Lượt định kỳ thất bại chỉ được thử lại sau khoảng này. */
export const RETRY_AFTER_MINUTES = 15;

export type ScheduleOutcome =
  | 'TOO_EARLY'
  | 'DONE'
  | 'IN_PROGRESS'
  | 'GAVE_UP'
  | 'WAITING'
  | 'SKIPPED'
  | 'RAN';

/** Mỗi tick của worker: đối soát ngày hôm qua (UTC) cho một tenant nếu chưa làm xong. An toàn khi nhiều worker chạy song song. */
export class ScheduleDailyReconciliation {
  /** tenant → ngày đã xong hoặc đã bỏ cuộc; tránh truy vấn DB mỗi 500 ms sau đó. */
  readonly #settled = new Map<string, string>();

  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      run: Pick<RunReconciliation, 'execute'>;
      clock: Clock;
      log: Logger;
      options: { atUtcHour: number; maxAttempts: number };
    },
  ) {}

  async execute(tenant: TenantId): Promise<ScheduleOutcome> {
    const now = this.deps.clock.now();
    if (now.getUTCHours() < this.deps.options.atUtcHour) return 'TOO_EARLY';
    const day = yesterdayUtc(now);
    if (this.#settled.get(tenant.value) === day) return 'DONE';

    const staleBefore = new Date(now.getTime() - STALE_RUN_MINUTES * 60_000);
    const state = await this.deps.uow.run(tenant, async ({ reconciliation }) => {
      const stale = await reconciliation.failStaleRuns(
        staleBefore,
        'abandoned: the run did not finish in time',
        now,
      );
      return { stale, ...(await reconciliation.scheduledRunsFor(day)) };
    });
    if (state.stale > 0) {
      this.deps.log.warn({ tenantId: tenant.value, day, stale: state.stale }, 'abandoned stale reconciliation runs');
    }

    if (state.completed > 0) {
      this.#settled.set(tenant.value, day);
      return 'DONE';
    }
    if (state.running > 0) return 'IN_PROGRESS';
    if (state.failed >= this.deps.options.maxAttempts) {
      this.#settled.set(tenant.value, day);
      this.deps.log.error(
        { tenantId: tenant.value, day, attempts: state.failed },
        'scheduled reconciliation gave up; run it manually once the cause is fixed',
      );
      return 'GAVE_UP';
    }
    if (
      state.lastFailedAt !== null &&
      now.getTime() - state.lastFailedAt.getTime() < RETRY_AFTER_MINUTES * 60_000
    ) {
      return 'WAITING';
    }

    const run = await this.deps.run.execute({ tenant, day, triggeredBy: 'SCHEDULED' });
    if (run === null) return 'SKIPPED';
    if (run.status === 'COMPLETED') this.#settled.set(tenant.value, day);
    return 'RAN';
  }
}
```

- [ ] **Step 4: Run to verify pass** — `corepack pnpm test:integration schedule-daily-reconciliation` → PASS; `corepack pnpm lint && corepack pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add services/wallet/src/application
git commit -m "feat(wallet): daily reconciliation scheduler (retry spacing, stale-run recovery)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Operator use cases, views, background runs, manual start

**Files:**
- Create: `services/wallet/src/application/reconciliation-views.ts`
- Create: `services/wallet/src/application/get-reconciliation-run.ts`
- Create: `services/wallet/src/application/list-reconciliation-items.ts`
- Create: `services/wallet/src/application/resolve-reconciliation-item.ts`
- Create: `services/wallet/src/application/background-runs.ts`
- Create: `services/wallet/src/application/start-manual-reconciliation.ts`
- Create: `services/wallet/src/application/reconciliation-operations.integration.test.ts`
- Create: `services/wallet/src/application/background-runs.test.ts`

**Interfaces:**
- Consumes: `ReconciliationRepository`, `RunReconciliation.begin/finish`, `validateResolution`, errors from Task 4, `InvalidQueryError`.
- Produces:
  - `toRunView(run)` / `toItemView(item)` and types `ReconciliationRunView`, `ReconciliationItemView` (dates as ISO strings).
  - `GetReconciliationRun({ uow }).execute({ tenant, runId }): Promise<ReconciliationRunView>` (`ReconciliationNotFoundError`).
  - `ListReconciliationItems({ uow }).execute({ tenant, runId, caseStatus?, limit?, cursor? }): Promise<{ items: ReconciliationItemView[]; nextCursor: string | null }>` (`ReconciliationNotFoundError`, `InvalidQueryError`; limit 1..500 default 100; `cursor` = last item's `seq` as a digit string).
  - `ResolveReconciliationItem({ uow, clock }).execute({ tenant, itemId, status, note, resolvedBy }): Promise<ReconciliationItemView>` (`InvalidReconciliationError`, `ReconciliationItemNotFoundError`, `ReconciliationConflictError`; same input again returns the same result).
  - `BackgroundRuns(log)` with `submit(context: object, work: () => Promise<unknown>): void` and `drain(): Promise<void>`.
  - `StartManualReconciliation({ run, background }).execute({ tenant, day }): Promise<{ runId: string; status: 'RUNNING' }>`.

- [ ] **Step 1: Write the failing tests**

`background-runs.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { BackgroundRuns } from './background-runs.js';
import type { Logger } from './ports.js';

const logger = (): Logger & { errors: object[] } => {
  const errors: object[] = [];
  return {
    errors,
    info: () => undefined,
    warn: () => undefined,
    error: (details) => {
      errors.push(details);
    },
  };
};

describe('BackgroundRuns', () => {
  it('drain waits for work that is still running', async () => {
    const background = new BackgroundRuns(logger());
    let finished = false;
    background.submit({}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      finished = true;
    });
    await background.drain();
    expect(finished).toBe(true);
  });

  it('logs a failure instead of leaving an unhandled rejection, and keeps draining', async () => {
    const log = logger();
    const background = new BackgroundRuns(log);
    background.submit({ runId: 'r1' }, () => Promise.reject(new Error('boom')));
    background.submit({ runId: 'r2' }, () => {
      throw new Error('sync boom');
    });
    await background.drain();
    expect(log.errors).toHaveLength(2);
    expect(log.errors[0]).toMatchObject({ runId: 'r1' });
  });

  it('drain returns at once when nothing is pending', async () => {
    const spy = vi.fn();
    await new BackgroundRuns(logger()).drain();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

`reconciliation-operations.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidReconciliationError } from '../domain/errors.js';
import { createHarness, type Harness } from '../test-support.js';
import {
  InvalidQueryError,
  ReconciliationConflictError,
  ReconciliationItemNotFoundError,
  ReconciliationNotFoundError,
} from './errors.js';
import type { NewReconciliationItem } from './ports.js';
import { GetReconciliationRun } from './get-reconciliation-run.js';
import { ListReconciliationItems } from './list-reconciliation-items.js';
import { ResolveReconciliationItem } from './resolve-reconciliation-item.js';
import { StartManualReconciliation } from './start-manual-reconciliation.js';
import { BackgroundRuns } from './background-runs.js';

let h: Harness;
const t0 = new Date('2026-10-10T10:00:00.000Z');

const item = (id: string, overrides: Partial<NewReconciliationItem> = {}): NewReconciliationItem => ({
  id,
  kind: 'AMOUNT_MISMATCH',
  chargeId: `ch_${id}`,
  topupId: `tp_${id}`,
  amountGateway: 2000,
  amountWallet: 1000,
  currency: 'VND',
  detail: { reason: id },
  action: 'NONE',
  ...overrides,
});

beforeAll(async () => {
  h = await createHarness();
  await h.uow.run(h.acme, async ({ reconciliation }) => {
    await reconciliation.startRun({ id: 'run-1', day: '2026-10-09', triggeredBy: 'MANUAL', startedAt: t0 });
    await reconciliation.completeRun('run-1', {
      gatewayTotals: { VND: 2000 },
      walletTotals: { VND: 1000 },
      items: [item('i1'), item('i2'), item('i3', { action: 'AUTO_APPLIED', kind: 'MISSING_AT_WALLET' })],
      finishedAt: t0,
    });
  });
});
afterAll(async () => {
  await h.close();
});

describe('GetReconciliationRun', () => {
  it('returns the run as a JSON view and 404s for unknown or other-tenant runs', async () => {
    const get = new GetReconciliationRun({ uow: h.uow });
    expect(await get.execute({ tenant: h.acme, runId: 'run-1' })).toEqual({
      id: 'run-1',
      day: '2026-10-09',
      status: 'COMPLETED',
      triggeredBy: 'MANUAL',
      failureReason: null,
      gatewayTotals: { VND: 2000 },
      walletTotals: { VND: 1000 },
      itemCount: 3,
      startedAt: '2026-10-10T10:00:00.000Z',
      finishedAt: '2026-10-10T10:00:00.000Z',
    });
    await expect(get.execute({ tenant: h.acme, runId: 'nope' })).rejects.toBeInstanceOf(ReconciliationNotFoundError);
    await expect(get.execute({ tenant: h.beta, runId: 'run-1' })).rejects.toBeInstanceOf(ReconciliationNotFoundError);
  });
});

describe('ListReconciliationItems', () => {
  const build = () => new ListReconciliationItems({ uow: h.uow });

  it('filters by case status and pages with an opaque-looking numeric cursor', async () => {
    const open = await build().execute({ tenant: h.acme, runId: 'run-1', caseStatus: 'OPEN' });
    expect(open.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(open.nextCursor).toBeNull();
    expect(open.items[0]).toMatchObject({
      kind: 'AMOUNT_MISMATCH',
      amountGateway: 2000,
      amountWallet: 1000,
      detail: { reason: 'i1' },
      caseStatus: 'OPEN',
      resolvedAt: null,
    });

    const page1 = await build().execute({ tenant: h.acme, runId: 'run-1', limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(page1.nextCursor).toMatch(/^\d+$/);
    const page2 = await build().execute({ tenant: h.acme, runId: 'run-1', limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).toEqual(['i3']);
    expect(page2.nextCursor).toBeNull();
  });

  it('rejects bad queries and unknown runs', async () => {
    const use = build();
    for (const bad of [
      { limit: 0 },
      { limit: 501 },
      { limit: 1.5 },
      { limit: Number.NaN },
      { cursor: 'abc' },
      { cursor: '-1' },
      { caseStatus: 'DONE' },
    ]) {
      await expect(
        use.execute({ tenant: h.acme, runId: 'run-1', ...(bad as object) } as never),
      ).rejects.toBeInstanceOf(InvalidQueryError);
    }
    await expect(use.execute({ tenant: h.acme, runId: 'nope' })).rejects.toBeInstanceOf(ReconciliationNotFoundError);
  });
});

describe('ResolveReconciliationItem', () => {
  const resolve = () => new ResolveReconciliationItem({ uow: h.uow, clock: h.clock });
  const input = () => ({
    tenant: h.acme,
    itemId: 'i1',
    status: 'RESOLVED',
    note: 'refunded manually',
    resolvedBy: 'ops-1',
  });

  it('closes an open item and returns the same result when repeated', async () => {
    h.clock.set('2026-10-11T08:00:00.000Z');
    const first = await resolve().execute(input());
    expect(first).toMatchObject({
      id: 'i1',
      caseStatus: 'RESOLVED',
      resolvedBy: 'ops-1',
      resolutionNote: 'refunded manually',
      resolvedAt: '2026-10-11T08:00:00.000Z',
    });
    h.clock.set('2026-10-11T09:00:00.000Z');
    expect(await resolve().execute(input())).toEqual(first);
  });

  it('answers 409 when the item was closed with different values, and for auto-applied items', async () => {
    await expect(
      resolve().execute({ ...input(), note: 'a different note' }),
    ).rejects.toBeInstanceOf(ReconciliationConflictError);
    await expect(
      resolve().execute({ ...input(), itemId: 'i3' }),
    ).rejects.toBeInstanceOf(ReconciliationConflictError);
  });

  it('validates the input and finds the item only in its own tenant', async () => {
    for (const bad of [{ note: '  ' }, { note: 'x'.repeat(501) }, { status: 'OPEN' }, { resolvedBy: '' }]) {
      await expect(resolve().execute({ ...input(), itemId: 'i2', ...bad })).rejects.toBeInstanceOf(
        InvalidReconciliationError,
      );
    }
    await expect(resolve().execute({ ...input(), itemId: 'nope' })).rejects.toBeInstanceOf(
      ReconciliationItemNotFoundError,
    );
    await expect(resolve().execute({ ...input(), tenant: h.beta, itemId: 'i2' })).rejects.toBeInstanceOf(
      ReconciliationItemNotFoundError,
    );
  });

  it('serialises two simultaneous resolves of one item: one wins, the other repeats or conflicts', async () => {
    const results = await Promise.allSettled([
      resolve().execute({ ...input(), itemId: 'i2', note: 'first' }),
      resolve().execute({ ...input(), itemId: 'i2', note: 'second' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ReconciliationConflictError);
  });
});

describe('StartManualReconciliation', () => {
  it('creates the run, returns its id at once and finishes it in the background', async () => {
    const finished: string[] = [];
    const background = new BackgroundRuns({ info: () => undefined, warn: () => undefined, error: () => undefined });
    const start = new StartManualReconciliation({
      run: {
        begin: async ({ tenant, day }) => ({ tenant, runId: 'run-x', day }),
        finish: async (handle) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          finished.push(handle.runId);
          return {} as never;
        },
      },
      background,
    });
    expect(await start.execute({ tenant: h.acme, day: '2026-10-09' })).toEqual({ runId: 'run-x', status: 'RUNNING' });
    expect(finished).toEqual([]);
    await background.drain();
    expect(finished).toEqual(['run-x']);
  });

  it('propagates an invalid day without starting anything in the background', async () => {
    const background = new BackgroundRuns({ info: () => undefined, warn: () => undefined, error: () => undefined });
    const start = new StartManualReconciliation({
      run: {
        begin: async () => {
          throw new InvalidReconciliationError('date must not be in the future');
        },
        finish: async () => {
          throw new Error('must not run');
        },
      },
      background,
    });
    await expect(start.execute({ tenant: h.acme, day: '2999-01-01' })).rejects.toBeInstanceOf(InvalidReconciliationError);
    await background.drain();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `corepack pnpm exec vitest run services/wallet/src/application/background-runs.test.ts` and `corepack pnpm test:integration reconciliation-operations` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`reconciliation-views.ts`:

```ts
import type { ReconciliationItem, ReconciliationRun } from './ports.js';

export interface ReconciliationRunView {
  id: string;
  day: string;
  status: string;
  triggeredBy: string;
  failureReason: string | null;
  gatewayTotals: Record<string, number>;
  walletTotals: Record<string, number>;
  itemCount: number;
  startedAt: string;
  finishedAt: string | null;
}

export function toRunView(run: ReconciliationRun): ReconciliationRunView {
  return {
    id: run.id,
    day: run.day,
    status: run.status,
    triggeredBy: run.triggeredBy,
    failureReason: run.failureReason,
    gatewayTotals: run.gatewayTotals,
    walletTotals: run.walletTotals,
    itemCount: run.itemCount,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export interface ReconciliationItemView {
  id: string;
  runId: string;
  kind: string;
  chargeId: string | null;
  topupId: string | null;
  amountGateway: number | null;
  amountWallet: number | null;
  currency: string | null;
  detail: Record<string, unknown>;
  action: string;
  caseStatus: string;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export function toItemView(item: ReconciliationItem): ReconciliationItemView {
  return {
    id: item.id,
    runId: item.runId,
    kind: item.kind,
    chargeId: item.chargeId,
    topupId: item.topupId,
    amountGateway: item.amountGateway,
    amountWallet: item.amountWallet,
    currency: item.currency,
    detail: item.detail,
    action: item.action,
    caseStatus: item.caseStatus,
    resolvedBy: item.resolvedBy,
    resolutionNote: item.resolutionNote,
    resolvedAt: item.resolvedAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}
```

`get-reconciliation-run.ts`:

```ts
import type { TenantId } from '../domain/tenant-id.js';
import { ReconciliationNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toRunView, type ReconciliationRunView } from './reconciliation-views.js';

export class GetReconciliationRun {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: { tenant: TenantId; runId: string }): Promise<ReconciliationRunView> {
    const run = await this.deps.uow.run(input.tenant, ({ reconciliation }) =>
      reconciliation.findRun(input.runId),
    );
    if (run === null) throw new ReconciliationNotFoundError(`reconciliation run ${input.runId} not found`);
    return toRunView(run);
  }
}
```

`list-reconciliation-items.ts`:

```ts
import type { CaseStatus } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import { InvalidQueryError, ReconciliationNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toItemView, type ReconciliationItemView } from './reconciliation-views.js';

export const DEFAULT_ITEM_LIMIT = 100;
export const MAX_ITEM_LIMIT = 500;
const CASE_STATUSES: readonly string[] = ['OPEN', 'RESOLVED', 'IGNORED'];

export class ListReconciliationItems {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: {
    tenant: TenantId;
    runId: string;
    caseStatus?: string | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
  }): Promise<{ items: ReconciliationItemView[]; nextCursor: string | null }> {
    const limit = input.limit ?? DEFAULT_ITEM_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ITEM_LIMIT) {
      throw new InvalidQueryError(`limit must be an integer in 1..${MAX_ITEM_LIMIT}`);
    }
    if (input.cursor !== undefined && !/^\d{1,15}$/.test(input.cursor)) {
      throw new InvalidQueryError('cursor is invalid');
    }
    if (input.caseStatus !== undefined && !CASE_STATUSES.includes(input.caseStatus)) {
      throw new InvalidQueryError('caseStatus must be OPEN, RESOLVED or IGNORED');
    }
    const afterSeq = input.cursor === undefined ? 0 : Number(input.cursor);
    const caseStatus = (input.caseStatus ?? null) as CaseStatus | null;

    const rows = await this.deps.uow.run(input.tenant, async ({ reconciliation }) => {
      if ((await reconciliation.findRun(input.runId)) === null) return null;
      // Đọc dư một dòng để biết còn trang sau hay không.
      return reconciliation.listItems({ runId: input.runId, caseStatus, afterSeq, limit: limit + 1 });
    });
    if (rows === null) throw new ReconciliationNotFoundError(`reconciliation run ${input.runId} not found`);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toItemView),
      nextCursor: rows.length > limit && last ? String(last.seq) : null,
    };
  }
}
```

`resolve-reconciliation-item.ts`:

```ts
import { validateResolution } from '../domain/reconciliation.js';
import type { TenantId } from '../domain/tenant-id.js';
import { ReconciliationConflictError, ReconciliationItemNotFoundError } from './errors.js';
import type { Clock, TenantUnitOfWork } from './ports.js';
import { toItemView, type ReconciliationItemView } from './reconciliation-views.js';

/** Đóng một ca lệch bằng ghi chú và người xử lý. Không sửa sổ cái; lặp lại cùng giá trị thì trả cùng kết quả. */
export class ResolveReconciliationItem {
  constructor(private readonly deps: { uow: TenantUnitOfWork; clock: Clock }) {}

  async execute(input: {
    tenant: TenantId;
    itemId: string;
    status: string;
    note: string;
    resolvedBy: string;
  }): Promise<ReconciliationItemView> {
    const resolution = validateResolution(input);
    const now = this.deps.clock.now();
    return this.deps.uow.run(input.tenant, async ({ reconciliation }) => {
      const item = await reconciliation.lockItem(input.itemId);
      if (item === null) {
        throw new ReconciliationItemNotFoundError(`reconciliation item ${input.itemId} not found`);
      }
      if (item.caseStatus === 'OPEN') {
        await reconciliation.resolveItem(item.id, { ...resolution, at: now });
        return toItemView({
          ...item,
          caseStatus: resolution.status,
          resolvedBy: resolution.resolvedBy,
          resolutionNote: resolution.note,
          resolvedAt: now,
        });
      }
      const same =
        item.caseStatus === resolution.status &&
        item.resolvedBy === resolution.resolvedBy &&
        item.resolutionNote === resolution.note;
      if (same) return toItemView(item);
      throw new ReconciliationConflictError(`item ${item.id} is already ${item.caseStatus}`);
    });
  }
}
```

`background-runs.ts`:

```ts
import type { Logger } from './ports.js';

/**
 * Chạy việc nền không chờ (lượt đối soát do API khởi tạo). Không để lỗi thành rejection chưa xử lý và cho phép
 * dịch vụ tắt đợi các việc đang chạy.
 */
export class BackgroundRuns {
  readonly #pending = new Set<Promise<void>>();

  constructor(private readonly log: Logger) {}

  submit(context: object, work: () => Promise<unknown>): void {
    const task: Promise<void> = (async () => {
      await work();
    })()
      .catch((error: unknown) => {
        try {
          this.log.error({ err: error, ...context }, 'background reconciliation failed');
        } catch {
          // Logger hỏng không được phép biến thành lỗi chưa xử lý.
        }
      })
      .finally(() => {
        this.#pending.delete(task);
      });
    this.#pending.add(task);
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }
}
```

`start-manual-reconciliation.ts`:

```ts
import type { TenantId } from '../domain/tenant-id.js';
import type { BackgroundRuns } from './background-runs.js';
import type { RunReconciliation } from './run-reconciliation.js';

/** `POST /reconciliations`: tạo lượt ngay (để trả `runId`), phần còn lại chạy nền. */
export class StartManualReconciliation {
  constructor(
    private readonly deps: {
      run: Pick<RunReconciliation, 'begin' | 'finish'>;
      background: Pick<BackgroundRuns, 'submit'>;
    },
  ) {}

  async execute(input: { tenant: TenantId; day: string }): Promise<{ runId: string; status: 'RUNNING' }> {
    const handle = await this.deps.run.begin({ tenant: input.tenant, day: input.day, triggeredBy: 'MANUAL' });
    if (handle === null) throw new Error('a manual reconciliation run must always be created');
    this.deps.background.submit({ tenantId: input.tenant.value, runId: handle.runId }, () =>
      this.deps.run.finish(handle),
    );
    return { runId: handle.runId, status: 'RUNNING' };
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run the two commands from Step 2 → PASS. `corepack pnpm lint && corepack pnpm typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add services/wallet/src/application
git commit -m "feat(wallet): reconciliation operator use cases (get, list, resolve, manual start)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: HTTP API (tenant guard, controller, error mapping, Nest wiring)

**Files:**
- Create: `services/wallet/src/interface/http/tenant.guard.ts`
- Create: `services/wallet/src/interface/http/reconciliations.controller.ts`
- Modify: `services/wallet/src/interface/http/tokens.ts`
- Modify: `services/wallet/src/interface/http/errors.ts`
- Modify: `services/wallet/src/app.module.ts`
- Modify: `services/wallet/src/interface/http/api.integration.test.ts` (extend `buildDeps`)
- Create: `services/wallet/src/interface/http/reconciliations.api.integration.test.ts`

**Interfaces:**
- Consumes: Task 8 use cases.
- Produces: `AppDeps` gains `startReconciliation`, `getReconciliationRun`, `listReconciliationItems`, `resolveReconciliationItem` (each `Pick<…, 'execute'>`); routes `POST /reconciliations` (202 `{runId,status}`), `GET /reconciliations/:runId`, `GET /reconciliations/:runId/items?caseStatus&limit&cursor`, `POST /reconciliation-items/:id/resolve` (200). These are internal operator endpoints: tenant comes from `x-tenant-id` only (no customer header); authentication belongs to the gateway like the other endpoints.

- [ ] **Step 1: Tokens, guard, error mapping**

Append to `tokens.ts`:

```ts
export const START_RECONCILIATION = Symbol('START_RECONCILIATION');
export const GET_RECONCILIATION_RUN = Symbol('GET_RECONCILIATION_RUN');
export const LIST_RECONCILIATION_ITEMS = Symbol('LIST_RECONCILIATION_ITEMS');
export const RESOLVE_RECONCILIATION_ITEM = Symbol('RESOLVE_RECONCILIATION_ITEM');
```

`tenant.guard.ts`:

```ts
import {
  Inject,
  Injectable,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { TenantRegistry } from '../../application/ports.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { TENANT_REGISTRY } from './tokens.js';

type TenantRequest = FastifyRequest & { reconciliationTenant?: TenantId };

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(',') : value;

/** Cho API vận hành (không gắn với khách): chỉ cần tenant, lấy từ header do gateway đặt. */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TenantRequest>();
    request.reconciliationTenant = this.registry.resolve(headerValue(request.headers['x-tenant-id']));
    return true;
  }
}

export const CurrentTenant = createParamDecorator((_data: unknown, context: ExecutionContext): TenantId => {
  const tenant = context.switchToHttp().getRequest<TenantRequest>().reconciliationTenant;
  if (!tenant) throw new Error('TenantGuard did not run before CurrentTenant');
  return tenant;
});
```

In `errors.ts` import `ReconciliationConflictError, ReconciliationItemNotFoundError, ReconciliationNotFoundError` from `application/errors.js` and `InvalidReconciliationError` from `domain/errors.js`, and add to `RULES`:

```ts
    {
      matches: (e) => e instanceof InvalidReconciliationError,
      status: 422,
      code: 'INVALID_RECONCILIATION',
    },
    {
      matches: (e) => e instanceof ReconciliationNotFoundError,
      status: 404,
      code: 'RECONCILIATION_NOT_FOUND',
    },
    {
      matches: (e) => e instanceof ReconciliationItemNotFoundError,
      status: 404,
      code: 'RECONCILIATION_ITEM_NOT_FOUND',
    },
    {
      matches: (e) => e instanceof ReconciliationConflictError,
      status: 409,
      code: 'RECONCILIATION_CONFLICT',
    },
```

- [ ] **Step 2: Controller** — `reconciliations.controller.ts`:

```ts
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { InvalidQueryError } from '../../application/errors.js';
import type { GetReconciliationRun } from '../../application/get-reconciliation-run.js';
import type { ListReconciliationItems } from '../../application/list-reconciliation-items.js';
import type { ResolveReconciliationItem } from '../../application/resolve-reconciliation-item.js';
import type { StartManualReconciliation } from '../../application/start-manual-reconciliation.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { ApiError } from './errors.js';
import { CurrentTenant, TenantGuard } from './tenant.guard.js';
import {
  GET_RECONCILIATION_RUN,
  LIST_RECONCILIATION_ITEMS,
  RESOLVE_RECONCILIATION_ITEM,
  START_RECONCILIATION,
} from './tokens.js';

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Trường không phải chuỗi coi như rỗng để use case từ chối bằng 422 (không phải 400). */
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

@Controller()
@UseGuards(TenantGuard)
export class ReconciliationsController {
  constructor(
    @Inject(START_RECONCILIATION) private readonly start: Pick<StartManualReconciliation, 'execute'>,
    @Inject(GET_RECONCILIATION_RUN) private readonly getRun: Pick<GetReconciliationRun, 'execute'>,
    @Inject(LIST_RECONCILIATION_ITEMS) private readonly listItems: Pick<ListReconciliationItems, 'execute'>,
    @Inject(RESOLVE_RECONCILIATION_ITEM) private readonly resolve: Pick<ResolveReconciliationItem, 'execute'>,
  ) {}

  @Post('reconciliations')
  @HttpCode(202)
  create(@CurrentTenant() tenant: TenantId, @Body() body: unknown) {
    return this.start.execute({ tenant, day: text(bodyObject(body).date) });
  }

  @Get('reconciliations/:runId')
  get(@CurrentTenant() tenant: TenantId, @Param('runId') runId: string) {
    return this.getRun.execute({ tenant, runId });
  }

  @Get('reconciliations/:runId/items')
  items(
    @CurrentTenant() tenant: TenantId,
    @Param('runId') runId: string,
    @Query('caseStatus') caseStatus?: string | string[],
    @Query('limit') limit?: string | string[],
    @Query('cursor') cursor?: string | string[],
  ) {
    if (Array.isArray(caseStatus) || Array.isArray(limit) || Array.isArray(cursor)) {
      throw new InvalidQueryError('caseStatus, limit and cursor must each be given at most once');
    }
    return this.listItems.execute({
      tenant,
      runId,
      caseStatus,
      limit: limit === undefined ? undefined : Number(limit),
      cursor,
    });
  }

  @Post('reconciliation-items/:id/resolve')
  @HttpCode(200)
  close(@CurrentTenant() tenant: TenantId, @Param('id') id: string, @Body() body: unknown) {
    const fields = bodyObject(body);
    return this.resolve.execute({
      tenant,
      itemId: id,
      status: text(fields.status),
      note: text(fields.note),
      resolvedBy: text(fields.resolvedBy),
    });
  }
}
```

- [ ] **Step 3: Nest wiring** — in `app.module.ts` import the four use-case types and the controller/tokens; add to `AppDeps`:

```ts
  startReconciliation: Pick<StartManualReconciliation, 'execute'>;
  getReconciliationRun: Pick<GetReconciliationRun, 'execute'>;
  listReconciliationItems: Pick<ListReconciliationItems, 'execute'>;
  resolveReconciliationItem: Pick<ResolveReconciliationItem, 'execute'>;
```

add `ReconciliationsController` to `controllers`, and these providers:

```ts
        { provide: START_RECONCILIATION, useValue: deps.startReconciliation },
        { provide: GET_RECONCILIATION_RUN, useValue: deps.getReconciliationRun },
        { provide: LIST_RECONCILIATION_ITEMS, useValue: deps.listReconciliationItems },
        { provide: RESOLVE_RECONCILIATION_ITEM, useValue: deps.resolveReconciliationItem },
```

In `api.integration.test.ts`'s `buildDeps` add (these existing tests never hit the new routes; stubs that fail loudly are enough):

```ts
    startReconciliation: { execute: () => Promise.reject(new Error('not used')) },
    getReconciliationRun: { execute: () => Promise.reject(new Error('not used')) },
    listReconciliationItems: { execute: () => Promise.reject(new Error('not used')) },
    resolveReconciliationItem: { execute: () => Promise.reject(new Error('not used')) },
```

(`bootstrap.ts` is updated in Task 10; until then `corepack pnpm typecheck` reports the missing deps there — run the integration test for this task only, and do Task 10 immediately after.)

- [ ] **Step 4: Write and run the API tests** — `reconciliations.api.integration.test.ts`:

```ts
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../app.module.js';
import { ApplyPaymentResult } from '../../application/apply-payment-result.js';
import { BackgroundRuns } from '../../application/background-runs.js';
import { CreateWallet } from '../../application/create-wallet.js';
import { GetReconciliationRun } from '../../application/get-reconciliation-run.js';
import { GetTopup } from '../../application/get-topup.js';
import { GetWallet } from '../../application/get-wallet.js';
import { ListEntries } from '../../application/list-entries.js';
import { ListReconciliationItems } from '../../application/list-reconciliation-items.js';
import { RequestTopup } from '../../application/request-topup.js';
import { ResolveReconciliationItem } from '../../application/resolve-reconciliation-item.js';
import { RunReconciliation } from '../../application/run-reconciliation.js';
import { StartManualReconciliation } from '../../application/start-manual-reconciliation.js';
import { createHarness, seedTopup, silentLogger, type Harness } from '../../test-support.js';
import { FakeSettlement, chargeFor, startDay } from '../../test-support-reconciliation.js';
import { createApp } from './create-app.js';

let h: Harness;
let app: NestFastifyApplication;
let settlement: FakeSettlement;
let background: BackgroundRuns;

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  settlement = new FakeSettlement();
  background = new BackgroundRuns(silentLogger);
  const apply = new ApplyPaymentResult({ uow: h.uow, clock: h.clock, ids: h.ids, log: silentLogger });
  const run = new RunReconciliation({
    uow: h.uow,
    settlement,
    applyPayment: apply,
    clock: h.clock,
    ids: h.ids,
    log: silentLogger,
    options: { autofix: true, maxItems: 1000 },
  });
  const deps: AppDeps = {
    registry: h.registry,
    clock: h.clock,
    log: silentLogger,
    webhookSecret: 'whsec_test_secret_value',
    createWallet: new CreateWallet({ uow: h.uow, clock: h.clock }),
    getWallet: new GetWallet({ uow: h.uow }),
    listEntries: new ListEntries({ uow: h.uow }),
    requestTopup: new RequestTopup({
      uow: h.uow,
      clock: h.clock,
      ids: h.ids,
      submitter: { submitSoon: () => undefined },
    }),
    getTopup: new GetTopup({ uow: h.uow }),
    applyPaymentResult: apply,
    startReconciliation: new StartManualReconciliation({ run, background }),
    getReconciliationRun: new GetReconciliationRun({ uow: h.uow }),
    listReconciliationItems: new ListReconciliationItems({ uow: h.uow }),
    resolveReconciliationItem: new ResolveReconciliationItem({ uow: h.uow, clock: h.clock }),
  };
  app = await createApp(deps);
});
afterEach(async () => {
  await background.drain();
  await app.close();
});

const acme = { 'x-tenant-id': 'acme' };
const errorOf = (body: string): { code: string; message: string } =>
  (JSON.parse(body) as { error: { code: string; message: string } }).error;

async function startRun(day: string, headers: Record<string, string> = acme) {
  return app.inject({ method: 'POST', url: '/reconciliations', headers, payload: { date: day } });
}

describe('POST /reconciliations', () => {
  it('answers 202 with the run id, then the run completes in the background', async () => {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 90000 });
    settlement.set(day, [chargeFor(topup), chargeFor(topup, { chargeId: 'ch_ghost', reference: 'tp_ghost' })]);

    const started = await startRun(day);
    expect(started.statusCode).toBe(202);
    const { runId, status } = started.json<{ runId: string; status: string }>();
    expect(status).toBe('RUNNING');
    await background.drain();

    const run = await app.inject({ method: 'GET', url: `/reconciliations/${runId}`, headers: acme });
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ id: runId, day, status: 'COMPLETED', triggeredBy: 'MANUAL', itemCount: 2 });

    const open = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items?caseStatus=OPEN`,
      headers: acme,
    });
    expect(open.json<{ items: Array<{ kind: string }> }>().items.map((i) => i.kind)).toEqual(['UNKNOWN_CHARGE']);
    const resolved = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items?caseStatus=RESOLVED`,
      headers: acme,
    });
    expect(resolved.json<{ items: Array<{ kind: string; action: string }> }>().items).toMatchObject([
      { kind: 'MISSING_AT_WALLET', action: 'AUTO_APPLIED' },
    ]);
  });

  it('rejects a bad date with 422 and a bad body with 400', async () => {
    const day = startDay(h);
    const tomorrow = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    for (const date of [tomorrow, '2027-02-30', 'yesterday', '']) {
      const res = await startRun(date);
      expect(res.statusCode, date).toBe(422);
      expect(errorOf(res.body).code).toBe('INVALID_RECONCILIATION');
    }
    const missing = await app.inject({ method: 'POST', url: '/reconciliations', headers: acme, payload: {} });
    expect(missing.statusCode).toBe(422);
    const notObject = await app.inject({
      method: 'POST',
      url: '/reconciliations',
      headers: { ...acme, 'content-type': 'application/json' },
      payload: JSON.stringify([1]),
    });
    expect(notObject.statusCode).toBe(400);
  });

  it('needs a known tenant', async () => {
    const day = startDay(h);
    expect((await startRun(day, {})).statusCode).toBe(400);
    expect(errorOf((await startRun(day, {})).body).code).toBe('MISSING_TENANT');
    const unknown = await startRun(day, { 'x-tenant-id': 'nobody' });
    expect(unknown.statusCode).toBe(403);
    expect(errorOf(unknown.body).code).toBe('UNKNOWN_TENANT');
  });
});

describe('reading runs and items', () => {
  it('404s for unknown runs and hides runs of other tenants', async () => {
    const day = startDay(h);
    const started = await startRun(day);
    const { runId } = started.json<{ runId: string }>();
    await background.drain();

    for (const url of [`/reconciliations/nope`, `/reconciliations/nope/items`]) {
      const res = await app.inject({ method: 'GET', url, headers: acme });
      expect(res.statusCode).toBe(404);
      expect(errorOf(res.body).code).toBe('RECONCILIATION_NOT_FOUND');
    }
    const other = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}`,
      headers: { 'x-tenant-id': 'beta' },
    });
    expect(other.statusCode).toBe(404);
  });

  it('pages items and validates the query', async () => {
    const day = startDay(h);
    const a = await seedTopup(h, { state: 'PENDING', amount: 1000 });
    const b = await seedTopup(h, { state: 'PENDING', amount: 2000 });
    settlement.set(day, [chargeFor(a, { amount: 1500 }), chargeFor(b, { amount: 2500 })]);
    const { runId } = (await startRun(day)).json<{ runId: string }>();
    await background.drain();

    const first = await app.inject({ method: 'GET', url: `/reconciliations/${runId}/items?limit=1`, headers: acme });
    const page1 = first.json<{ items: Array<{ kind: string }>; nextCursor: string | null }>();
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const second = await app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items?limit=1&cursor=${page1.nextCursor}`,
      headers: acme,
    });
    const page2 = second.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    for (const query of ['limit=0', 'limit=abc', 'cursor=x', 'caseStatus=DONE', 'limit=1&limit=2']) {
      const res = await app.inject({ method: 'GET', url: `/reconciliations/${runId}/items?${query}`, headers: acme });
      expect(res.statusCode, query).toBe(400);
      expect(errorOf(res.body).code).toBe('INVALID_QUERY');
    }
  });
});

describe('POST /reconciliation-items/:id/resolve', () => {
  async function openItem(): Promise<string> {
    const day = startDay(h);
    const topup = await seedTopup(h, { state: 'PENDING', amount: 1000 });
    settlement.set(day, [chargeFor(topup, { amount: 1500 })]);
    const { runId } = (await startRun(day)).json<{ runId: string }>();
    await background.drain();
    const items = await app.inject({ method: 'GET', url: `/reconciliations/${runId}/items`, headers: acme });
    return items.json<{ items: Array<{ id: string }> }>().items[0]!.id;
  }
  const resolve = (id: string, payload: unknown, headers: Record<string, string> = acme) =>
    app.inject({ method: 'POST', url: `/reconciliation-items/${id}/resolve`, headers, payload: payload as object });

  it('closes a case, is idempotent, and 409s on a different resolution', async () => {
    const id = await openItem();
    const body = { status: 'RESOLVED', note: 'adjusted by finance', resolvedBy: 'ops-1' };

    const first = await resolve(id, body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id, caseStatus: 'RESOLVED', resolvedBy: 'ops-1', resolutionNote: 'adjusted by finance' });
    expect((await resolve(id, body)).json()).toEqual(first.json());

    const conflict = await resolve(id, { ...body, status: 'IGNORED' });
    expect(conflict.statusCode).toBe(409);
    expect(errorOf(conflict.body).code).toBe('RECONCILIATION_CONFLICT');
  });

  it('validates the body with 422 and finds items only in the caller tenant', async () => {
    const id = await openItem();
    for (const bad of [
      { status: 'RESOLVED', resolvedBy: 'ops' },
      { status: 'RESOLVED', note: '   ', resolvedBy: 'ops' },
      { status: 'OPEN', note: 'x', resolvedBy: 'ops' },
      { status: 'RESOLVED', note: 'x' },
      { status: 'RESOLVED', note: 'x'.repeat(501), resolvedBy: 'ops' },
    ]) {
      const res = await resolve(id, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(422);
    }
    const missing = await resolve('nope', { status: 'RESOLVED', note: 'x', resolvedBy: 'ops' });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing.body).code).toBe('RECONCILIATION_ITEM_NOT_FOUND');
    const otherTenant = await resolve(id, { status: 'RESOLVED', note: 'x', resolvedBy: 'ops' }, { 'x-tenant-id': 'beta' });
    expect(otherTenant.statusCode).toBe(404);
  });
});
```

Run: `corepack pnpm test:integration reconciliations.api api.integration` → PASS (the existing API tests must still pass). `corepack pnpm lint` → clean (the HTTP layer must not import infrastructure).

- [ ] **Step 5: Commit**

```bash
git add services/wallet/src
git commit -m "feat(wallet): reconciliation HTTP API (run, read, close cases)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Bootstrap wiring and end-to-end test

**Files:**
- Modify: `services/wallet/src/bootstrap.ts`
- Modify: `packages/testing/src/fake-payment-server.ts` (+ its test)
- Create: `services/wallet/src/reconciliation.integration.test.ts`

**Interfaces:**
- Consumes: everything above; `config.reconciliation`, `config.payment`.
- Produces: the service runs the daily task in its worker, serves the new endpoints, and drains background runs on shutdown.

- [ ] **Step 1: Let `FakePaymentServer` route by request** — in `fake-payment-server.ts` change the fallback type and pass the request:

```ts
  #fallback: (requestNumber: number, request: FakePaymentRequest) => FakePaymentResponse = defaultResponse;
```

In the request handler replace the push/response lines with:

```ts
        const request: FakePaymentRequest = {
          method: req.method ?? '',
          url: req.url ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        fake?.requests.push(request);
        const response = fake?.nextResponse(request) ?? defaultResponse(0);
```

`setFallback(fallback: (requestNumber: number, request: FakePaymentRequest) => FakePaymentResponse): this`, and `private nextResponse(request: FakePaymentRequest): FakePaymentResponse { return this.#queue.shift() ?? this.#fallback(this.requests.length, request); }`. Existing callers keep working (extra argument ignored). Add a test to `fake-payment-server.test.ts` in the file's existing style:

```ts
  it('passes the request to the fallback so a test can answer by URL', async () => {
    const fake = await FakePaymentServer.start();
    fake.setFallback((_number, request) => ({ status: 200, body: { url: request.url } }));
    const response = await fetch(`${fake.baseUrl}/settlements?date=2026-10-10`);
    expect(await response.json()).toEqual({ url: '/settlements?date=2026-10-10' });
    await fake.close();
  });
```

Run: `corepack pnpm exec vitest run packages/testing/src/fake-payment-server.test.ts` → PASS.

- [ ] **Step 2: Wire `bootstrap.ts`**

Add imports:

```ts
import { BackgroundRuns } from './application/background-runs.js';
import { GetReconciliationRun } from './application/get-reconciliation-run.js';
import { ListReconciliationItems } from './application/list-reconciliation-items.js';
import { ResolveReconciliationItem } from './application/resolve-reconciliation-item.js';
import { RunReconciliation } from './application/run-reconciliation.js';
import { ScheduleDailyReconciliation } from './application/schedule-daily-reconciliation.js';
import { StartManualReconciliation } from './application/start-manual-reconciliation.js';
import { HttpSettlementSource } from './infrastructure/http-settlement-source.js';
```

After `const orderReady = …` add:

```ts
  const applyPaymentResult = new ApplyPaymentResult({ uow, clock, ids, log });
  const reconciliation = new RunReconciliation({
    uow,
    settlement: new HttpSettlementSource({
      baseUrl: config.payment.baseUrl,
      timeoutMs: config.payment.timeoutMs,
    }),
    applyPayment: applyPaymentResult,
    clock,
    ids,
    log,
    options: {
      autofix: config.reconciliation.autofix,
      maxItems: config.reconciliation.maxItems,
    },
  });
  const scheduleDaily = new ScheduleDailyReconciliation({
    uow,
    run: reconciliation,
    clock,
    log,
    options: {
      atUtcHour: config.reconciliation.atUtcHour,
      maxAttempts: config.reconciliation.maxAttempts,
    },
  });
  const background = new BackgroundRuns(log);
```

In the `createApp({...})` call replace `applyPaymentResult: new ApplyPaymentResult({ uow, clock, ids, log }),` with `applyPaymentResult,` and add:

```ts
      startReconciliation: new StartManualReconciliation({ run: reconciliation, background }),
      getReconciliationRun: new GetReconciliationRun({ uow }),
      listReconciliationItems: new ListReconciliationItems({ uow }),
      resolveReconciliationItem: new ResolveReconciliationItem({ uow, clock }),
```

Add a worker task next to the others:

```ts
  const reconcileDailyForAllTenants = async (signal: AbortSignal): Promise<void> => {
    for (const tenant of registry.all()) {
      if (signal.aborted) return;
      try {
        const outcome = await scheduleDaily.execute(tenant);
        if (outcome === 'RAN') {
          log.info({ tenantId: tenant.value }, 'worker ran the daily reconciliation');
        }
      } catch (error) {
        log.error({ err: error, tenantId: tenant.value }, 'scheduling the daily reconciliation failed');
      }
    }
  };
```

and `tasks: [submitDueForAllTenants, relayOutboxForAllTenants, reconcileDailyForAllTenants],`. In the `stop` list add `() => background.drain(),` right after `() => submitter.drain(),`.

- [ ] **Step 3: Write the end-to-end test** — `services/wallet/src/reconciliation.integration.test.ts`:

```ts
import { createDatabase } from '@billing/database';
import {
  FakeClock,
  FakePaymentServer,
  createTestBroker,
  createTestDatabase,
  waitFor,
  type TestBroker,
  type TestDatabase,
} from '@billing/testing';
import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startService, type RunningService } from './bootstrap.js';
import type { WalletConfig } from './config.js';
import { TenantId } from './domain/tenant-id.js';
import { provisionTenants } from './infrastructure/kysely/provisioning.js';
import type { WalletDatabase } from './infrastructure/kysely/schema.js';

const acme = TenantId.parse('acme');
const beta = TenantId.parse('beta');

let testDb: TestDatabase;
let broker: TestBroker;
let db: Kysely<WalletDatabase>;
let fake: FakePaymentServer;
let clock: FakeClock;
let counter = 0;
const running: RunningService[] = [];
/** Sao kê giả của payment theo ngày. */
const settlements = new Map<string, unknown[]>();

beforeAll(async () => {
  testDb = await createTestDatabase('recsvc');
  broker = await createTestBroker('recsvc');
  db = createDatabase<WalletDatabase>(testDb.config);
  await provisionTenants(db as unknown as Kysely<unknown>, [acme, beta]);
});
afterAll(async () => {
  await db.destroy();
  await testDb.drop();
  await broker.drop();
});
beforeEach(async () => {
  settlements.clear();
  clock = new FakeClock('2026-10-10T10:00:00.000Z');
  fake = await FakePaymentServer.start();
  fake.setFallback((number, request) => {
    const url = new URL(request.url, 'http://fake');
    if (url.pathname === '/settlements') {
      const date = url.searchParams.get('date') ?? '';
      return {
        status: 200,
        body: { date, items: settlements.get(date) ?? [], nextCursor: null, totals: [] },
      };
    }
    return { status: 202, body: { chargeId: `ch_e2e_${number}`, status: 'PENDING' } };
  });
});
afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop();
  await fake.close();
});

const configFor = (): WalletConfig => ({
  port: 0,
  database: testDb.config,
  tenants: [acme, beta],
  payment: { baseUrl: fake.baseUrl, webhookSecret: 'whsec_recsvc', timeoutMs: 1000 },
  broker: broker.wallet,
  orders: { prefetch: 5, retryDelaysSeconds: [1, 2], outboxBatch: 50 },
  reconciliation: { autofix: true, atUtcHour: 0, maxAttempts: 3, maxItems: 1000 },
  topupBackoffSeconds: [1, 5],
  workerIntervalMs: 20,
});

async function start(): Promise<RunningService> {
  const service = await startService(configFor(), { clock });
  running.push(service);
  return service;
}

const operator = { 'x-tenant-id': 'acme' };
const caller = (customer: string) => ({ 'x-tenant-id': 'acme', 'x-customer-id': customer });
const topupRow = (topupId: string) =>
  db
    .withSchema('t_acme')
    .selectFrom('topups')
    .selectAll()
    .where('id', '=', topupId)
    .executeTakeFirstOrThrow();
const scheduledRuns = (tenant: 'acme' | 'beta', day: string) =>
  db
    .withSchema(`t_${tenant}`)
    .selectFrom('reconciliation_runs')
    .select('status')
    .where('run_day', '=', day)
    .where('triggered_by', '=', 'SCHEDULED')
    .execute();

describe('reconciliation in the running service', () => {
  it('credits a lost webhook exactly once when an operator runs the day by hand', async () => {
    const service = await start();
    const customer = `rec${++counter}`;
    const wallet = await service.app.inject({
      method: 'POST',
      url: '/wallets',
      headers: caller(customer),
      payload: { currency: 'VND' },
    });
    expect(wallet.statusCode).toBe(201);
    const created = await service.app.inject({
      method: 'POST',
      url: '/topups',
      headers: { ...caller(customer), 'idempotency-key': `key-${customer}` },
      payload: { amount: 150000 },
    });
    const { topupId } = created.json<{ topupId: string }>();
    await waitFor(async () => (await topupRow(topupId)).charge_id !== null);
    const chargeId = (await topupRow(topupId)).charge_id!;
    settlements.set('2026-10-10', [
      {
        chargeId,
        reference: topupId,
        amount: 150000,
        currency: 'VND',
        status: 'SUCCEEDED',
        metadata: { tenantId: 'acme' },
        completedAt: '2026-10-10T09:00:00.000Z',
      },
    ]);

    const started = await service.app.inject({
      method: 'POST',
      url: '/reconciliations',
      headers: operator,
      payload: { date: '2026-10-10' },
    });
    expect(started.statusCode).toBe(202);
    const { runId } = started.json<{ runId: string }>();
    await waitFor(async () => {
      const run = await service.app.inject({
        method: 'GET',
        url: `/reconciliations/${runId}`,
        headers: operator,
      });
      return run.json<{ status: string }>().status === 'COMPLETED';
    });

    const items = await service.app.inject({
      method: 'GET',
      url: `/reconciliations/${runId}/items`,
      headers: operator,
    });
    expect(items.json<{ items: Array<{ kind: string; action: string }> }>().items).toMatchObject([
      { kind: 'MISSING_AT_WALLET', action: 'AUTO_APPLIED' },
    ]);
    const balance = await service.app.inject({
      method: 'GET',
      url: '/wallet',
      headers: caller(customer),
    });
    expect(balance.json<{ balance: number }>().balance).toBe(150000);
  });

  it('runs the daily task on its own: one scheduled run per tenant for yesterday, never repeated', async () => {
    await start();
    await waitFor(
      async () =>
        (await scheduledRuns('acme', '2026-10-09')).some((r) => r.status === 'COMPLETED') &&
        (await scheduledRuns('beta', '2026-10-09')).some((r) => r.status === 'COMPLETED'),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await scheduledRuns('acme', '2026-10-09')).toHaveLength(1);
    expect(await scheduledRuns('beta', '2026-10-09')).toHaveLength(1);
  });

  it('finishes a manual run that is still in flight when the service stops', async () => {
    const service = await start();
    const started = await service.app.inject({
      method: 'POST',
      url: '/reconciliations',
      headers: operator,
      payload: { date: '2026-10-08' },
    });
    const { runId } = started.json<{ runId: string }>();

    await service.stop();

    const run = await db
      .withSchema('t_acme')
      .selectFrom('reconciliation_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run.status).not.toBe('RUNNING');
  });
});
```

(`service.stop()` is wrapped in `once`, so the `afterEach` stop of the same service is a no-op.)

- [ ] **Step 4: Run to verify**

Run: `corepack pnpm test:integration reconciliation.integration service.integration order-payment` → PASS (the older service tests prove the new worker task stays idle at `atUtcHour: 23`). Then `corepack pnpm typecheck && corepack pnpm lint && corepack pnpm format:check` → clean.

- [ ] **Step 5: Commit**

```bash
git add services/wallet packages/testing
git commit -m "feat(wallet): wire reconciliation into the service (worker task, API, shutdown drain)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Documentation (spec amendments, contract, ADR, runbook, README)

**Files:**
- Modify: `docs/superpowers/specs/2026-10-10-reconciliation-design.md`
- Create: `docs/integration/orders-reconciliation.vi.md`
- Create: `docs/integration/reconciliation-runbook.vi.md`
- Create: `docs/adr/0010-reconciliation-read-only-immutable-runs.vi.md`
- Modify: `docs/integration/orders-handoff.vi.md`, `README.md`, and any index that lists ADRs (`grep -rn "0009-order-payment" docs README.md`)

- [ ] **Step 1: Apply the clarifications to the spec** — edit the spec so it matches what was built (keep Vietnamese):
  - §3.2 table: `MISSING_AT_WALLET` condition becomes "Gateway `SUCCEEDED`, wallet có topup `REQUESTED`/`PENDING`, hoặc `FAILED` với `PAYMENT_UNAVAILABLE`"; `UNKNOWN_CHARGE` also covers "topup đã gắn với charge khác"; add one sentence that charges with a missing or foreign `metadata.tenantId` are ignored for that tenant's run; `MISSING_AT_GATEWAY` compares with the settlement of day D **and** D-1; the totals paragraph says the totals are informational (stored on the run), only per-item comparison produces discrepancies.
  - §3.3: event id is `reconcile:<runId>:<chargeId>`; an `IGNORED` outcome with the topup already `SUCCEEDED` counts as `AUTO_APPLIED` ("already settled"); other outcomes (`DUPLICATE`, `MISMATCH`, `UNKNOWN_TOPUP`, errors) are `FAILED_AUTOFIX`; `AUTO_APPLIED` items are stored `RESOLVED` by `system` with note `auto-applied by reconciliation`.
  - §4: add the scheduler rules (stale `RUNNING` runs older than 30 minutes become `FAILED`; a failed scheduled run is retried at most `RECONCILE_MAX_ATTEMPTS` times and at least 15 minutes apart; `DONE`/`GAVE_UP` are remembered in memory per tenant and day).
  - §5: column names are `run_day`, `triggered_by`, `seq` (identity, used as list cursor); the unique index is filtered on `triggered_by = 'SCHEDULED' and status <> 'FAILED'`.

- [ ] **Step 2: `docs/integration/orders-reconciliation.vi.md`** — write (Vietnamese) a document with these sections and exactly this substance:
  1. **Mục đích và trạng thái:** phép kiểm tra thứ ba của spec nền (§6.3) chưa chạy ở Bước 5 vì ecommerce chưa có dữ liệu để đối chiếu; tài liệu này là hợp đồng để hai bên làm theo.
  2. **Snapshot ecommerce cần cung cấp:** order `Paid` trong một ngày UTC theo tenant, mỗi dòng gồm `orderId` (UUID), `customerId`, `amount` (số nguyên đơn vị nhỏ nhất), `currency` (`VND`|`USD`), `paidAtUtc` (RFC 3339), `walletTransactionId` (lấy từ `OrderPaidV1`). Hai hình thức đề xuất: (a) endpoint chỉ đọc phân trang cursor `GET …?tenantId=&date=&cursor=`, (b) file xuất theo ngày; team ecommerce chọn.
  3. **Quy tắc đối chiếu wallet sẽ áp dụng khi có snapshot:** mỗi `ORDER_PAYMENT` (bảng `order_payments`) phải có order `Paid` khớp `orderId`, số tiền, đồng tiền, và ngược lại. Loại lệch dự kiến: `PAID_ONLY_AT_WALLET` (wallet đã trừ, order chưa `Paid` → phát lại `OrderPaidV1` từ outbox, cần công cụ phát lại, chưa có), `PAID_ONLY_AT_ORDERS` (order `Paid` mà wallet không có bút toán → ca thủ công), `ORDER_AMOUNT_MISMATCH` (ca thủ công).
  4. **Ràng buộc:** `Paid` là trạng thái cuối; đối soát chỉ báo lệch, không tự đổi trạng thái order; kết quả đến sai thứ tự là bình thường (xem tài liệu bàn giao Bước 4).
  5. **Câu hỏi mở cho ecommerce:** hình thức cung cấp snapshot; độ trễ chấp nhận được giữa `OrderPaidV1` và snapshot; cách định danh tenant trong snapshot (phải khớp `WALLET_TENANTS`).

- [ ] **Step 3: `docs/integration/reconciliation-runbook.vi.md`** — write (Vietnamese): how the daily run works (ngày D-1 UTC sau `RECONCILE_AT_UTC_HOUR`), how to run by hand (`curl` for `POST /reconciliations`, `GET /reconciliations/:runId`, `GET /reconciliations/:runId/items?caseStatus=OPEN`, `POST /reconciliation-items/:id/resolve`, always with `x-tenant-id` and — in real deployments — behind the gateway), and a table "loại lệch → ý nghĩa → việc cần làm" covering every kind:
  - `MISSING_AT_WALLET` / `AUTO_APPLIED`: không cần làm; `FAILED_AUTOFIX`: xem `detail.autofix`, kiểm tra topup và đóng ca sau khi xử lý.
  - `UNKNOWN_CHARGE`: có charge ở payment mà wallet không có topup (hoặc topup gắn charge khác): tiền đã thu nhưng không thuộc lần nạp nào; điều tra với team payment, không tự ghi sổ.
  - `MISSING_AT_GATEWAY`: wallet đã cộng tiền mà payment không có charge: nghi ngờ ghi sổ sai; đóng băng ví nếu cần (chưa có tính năng) và điều tra.
  - `AMOUNT_MISMATCH`, `STATUS_MISMATCH`: đối chiếu `detail`, quyết định bút toán điều chỉnh (chưa có API, làm ngoài hệ thống) rồi đóng ca `RESOLVED`; nếu là sai lệch chấp nhận được dùng `IGNORED` kèm lý do.
  - `LEDGER_UNBALANCED`, `BALANCE_MISMATCH`: lỗi toàn vẹn dữ liệu, mức cao nhất; dừng thay đổi ví của tenant, báo kỹ thuật ngay; log `ledger integrity check failed`.
  Plus: reading run status (`FAILED` + `failureReason`), what `GAVE_UP` means (log `scheduled reconciliation gave up`; fix the cause then POST a manual run), and the config variables with defaults.

- [ ] **Step 4: ADR-0010** (`docs/adr/0010-reconciliation-read-only-immutable-runs.vi.md`, same format as ADR-0009: Trạng thái / Bối cảnh / Quyết định / Phương án đã loại / Hệ quả). Decisions: đối soát chỉ đọc theo mặc định; chỉ tự ghi bù `MISSING_AT_WALLET` qua `ApplyPaymentResult` (eventId theo lượt, business key `topup:<id>` chống ghi đôi); lượt bất biến, chạy lại tạo lượt mới; ca thủ công đóng bằng ghi chú, không sửa sổ; mỗi tenant một lượt định kỳ mỗi ngày nhờ unique index lọc; không giữ transaction qua lời gọi HTTP. Rejected: sửa sổ cái tự động mọi loại lệch; một bảng đối soát dùng chung ngoài schema tenant (phá ADR-0006); lập lịch bằng cron ngoài (chưa có hạ tầng, Bước 6). Consequences: totals chỉ để tham khảo (biên ngày); charge không có `metadata.tenantId` không thuộc tenant nào nên không được báo; sao kê lớn bị chặn bởi `RECONCILE_MAX_ITEMS`; chưa có metric/cảnh báo (Bước 6); Wallet↔Orders chờ ecommerce.

- [ ] **Step 5: README and handoff** — in `README.md` add a short "Đối soát" subsection under the Wallet section: what it checks, the four endpoints with one `curl` example each (with `x-tenant-id: acme`), the `RECONCILE_*` variables, and links to the spec, ADR-0010 and the runbook; update the stale feature line if needed. In `docs/integration/orders-handoff.vi.md` add a short subsection pointing to `orders-reconciliation.vi.md` ("ecommerce sẽ cần cung cấp snapshot order `Paid`; chưa chặn việc triển khai Bước 4"). Add ADR-0010 wherever ADRs are indexed.

- [ ] **Step 6: Verify and commit**

Run: `corepack pnpm exec prettier --write docs README.md` then `corepack pnpm format:check` and `corepack pnpm test` (the handoff doc test must still pass) → clean.

```bash
git add docs README.md
git commit -m "docs: reconciliation spec amendments, Orders contract, runbook, ADR-0010

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Final gates

- [ ] **Step 1: Run everything**

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm format:check
corepack pnpm test
corepack pnpm test:integration
corepack pnpm test:contract
```

Expected: all green (previous baseline: 527 unit, 360 integration, 2 contract; the new counts are higher). `tools/boundaries.test.ts` is a known slow-under-load test; if it alone times out, re-run it by itself and report both results.

- [ ] **Step 2: Re-read the diff for leftovers** — `git diff main..HEAD --stat` and skim: no `console.log`, no `.only`, no secrets, no TODO/FIXME, no unused exports (`dateTime` import removed where unused).

- [ ] **Step 3: Report** — list the commits (`git log --oneline main..HEAD`) and the command outputs. Do NOT push or merge.
