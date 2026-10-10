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
