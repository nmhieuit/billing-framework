import { Money } from '@billing/money';
import { InvalidLedgerTransactionError } from './errors.js';

export interface LedgerEntry {
  readonly accountId: string;
  readonly amount: Money;
}

export type LedgerTransactionKind = 'TOPUP' | 'ORDER_PAYMENT' | 'ADJUSTMENT' | 'REVERSAL';

export interface LedgerTransactionProps {
  readonly id: string;
  readonly businessKey: string;
  readonly kind: LedgerTransactionKind;
  readonly entries: readonly LedgerEntry[];
  readonly reversesTransactionId: string | null;
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
    reverses?: string;
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
        throw new InvalidLedgerTransactionError(
          `account ${entry.accountId} appears more than once`,
        );
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
      reversesTransactionId: input.reverses ?? null,
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

  /** Điều chỉnh có đối ứng: CREDIT cộng ví, DEBIT trừ ví; đối ứng là tài khoản ADJUSTMENT cùng đồng tiền. */
  static adjustment(input: {
    id: string;
    actionId: string;
    walletAccountId: string;
    adjustmentAccountId: string;
    direction: 'CREDIT' | 'DEBIT';
    amount: Money;
    now: Date;
  }): LedgerTransaction {
    if (!input.amount.isPositive()) {
      throw new InvalidLedgerTransactionError('an adjustment amount must be positive');
    }
    const walletDelta = input.direction === 'CREDIT' ? input.amount : input.amount.negate();
    return LedgerTransaction.create({
      id: input.id,
      businessKey: `adjustment:${input.actionId}`,
      kind: 'ADJUSTMENT',
      entries: [
        { accountId: input.walletAccountId, amount: walletDelta },
        { accountId: input.adjustmentAccountId, amount: walletDelta.negate() },
      ],
      now: input.now,
    });
  }

  /** Đảo một giao dịch: mỗi dòng đổi dấu; chỉ thêm giao dịch mới, không sửa giao dịch gốc. */
  static reversal(input: {
    id: string;
    original: { id: string; entries: readonly LedgerEntry[] };
    now: Date;
  }): LedgerTransaction {
    return LedgerTransaction.create({
      id: input.id,
      businessKey: `reversal:${input.original.id}`,
      kind: 'REVERSAL',
      entries: input.original.entries.map((e) => ({
        accountId: e.accountId,
        amount: e.amount.negate(),
      })),
      reverses: input.original.id,
      now: input.now,
    });
  }

  toProps(): LedgerTransactionProps {
    return { ...this.props, entries: [...this.props.entries] };
  }
}
