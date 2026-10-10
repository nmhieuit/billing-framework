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
