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

  it.each(['', '   ', 'x'.repeat(MAX_REFERENCE_LENGTH + 1)])(
    'rejects reference %j',
    (reference) => {
      expect(() => Charge.create({ ...base, reference })).toThrow(InvalidChargeError);
    },
  );

  it('accepts a reference of exactly the maximum length', () => {
    expect(() =>
      Charge.create({ ...base, reference: 'x'.repeat(MAX_REFERENCE_LENGTH) }),
    ).not.toThrow();
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
    expect(done.toProps()).toMatchObject({
      status: 'SUCCEEDED',
      failureCode: null,
      completedAt: later,
    });
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
