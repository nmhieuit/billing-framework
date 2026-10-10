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
    .filter(
      (t) => t.status === 'SUCCEEDED' && (t.chargeId === null || !gatewayChargeIds.has(t.chargeId)),
    )
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
    throw new InvalidReconciliationError(
      `resolvedBy must be 1..${MAX_RESOLVED_BY_LENGTH} characters`,
    );
  }
  return { status: input.status, note, resolvedBy };
}
