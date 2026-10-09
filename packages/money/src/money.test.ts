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

  it.each([
    null,
    'x',
    {},
    { amount: '1', currency: 'VND' },
    { amount: 1 },
    { amount: 1.5, currency: 'VND' },
  ])('rejects malformed JSON %j', (value) => {
    expect(() => Money.fromJSON(value)).toThrow(InvalidMoneyError);
  });
});
