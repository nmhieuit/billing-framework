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
