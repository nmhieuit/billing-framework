import { Money, type Currency } from '@billing/money';
import type { CustomerId } from './customer-id.js';
import { InsufficientFundsError, LedgerInvariantError } from './errors.js';

export type AccountKind = 'WALLET' | 'GATEWAY' | 'MERCHANT' | 'ADJUSTMENT';

/** Trạng thái đóng băng ví: ai, lúc nào, vì sao. */
export interface FrozenState {
  readonly at: Date;
  readonly by: string;
  readonly reason: string;
}

export interface AccountProps {
  readonly id: string;
  readonly kind: AccountKind;
  readonly customerId: string | null;
  readonly currency: Currency;
  readonly balance: Money;
  readonly createdAt: Date;
  readonly frozen: FrozenState | null;
}

export class Account {
  private constructor(private readonly props: AccountProps) {}

  static walletId(customerId: CustomerId): string {
    return `wallet:${customerId.value}`;
  }

  static systemId(kind: 'GATEWAY' | 'MERCHANT' | 'ADJUSTMENT', currency: Currency): string {
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
      frozen: null,
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
      case 'ADJUSTMENT':
        // Tài khoản đối ứng điều chỉnh: không ràng buộc dấu.
        break;
    }
    return new Account({ ...this.props, balance: next });
  }

  isFrozen(): boolean {
    return this.props.frozen !== null;
  }

  /** Đóng băng ví (chỉ loại WALLET). Việc chặn ghi nợ do use case đảm nhiệm, không phải `apply`. */
  freeze(by: string, reason: string, at: Date): Account {
    if (this.props.kind !== 'WALLET') {
      throw new LedgerInvariantError(`only wallet accounts can be frozen: ${this.props.id}`);
    }
    return new Account({ ...this.props, frozen: { at, by, reason } });
  }

  unfreeze(): Account {
    return new Account({ ...this.props, frozen: null });
  }

  toProps(): AccountProps {
    return { ...this.props };
  }
}
