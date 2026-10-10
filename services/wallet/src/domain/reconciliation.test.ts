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
  createdAt: new Date('2026-10-08T09:00:00.000Z'),
  completedAt: new Date('2026-10-10T01:30:00.000Z'),
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
    expect(missing[0]?.detail).toEqual({
      walletStatus: 'SUCCEEDED',
      topupCreatedAt: '2026-10-08T09:00:00.000Z',
      topupCompletedAt: '2026-10-10T01:30:00.000Z',
    });
    expect(missing[0]).toMatchObject({
      amountWallet: 150000,
      amountGateway: null,
      currency: 'VND',
    });
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
      validateResolution({
        status: 'RESOLVED',
        note: '  checked with finance ',
        resolvedBy: ' ops-1 ',
      }),
    ).toEqual({ status: 'RESOLVED', note: 'checked with finance', resolvedBy: 'ops-1' });
    expect(validateResolution({ status: 'IGNORED', note: 'x', resolvedBy: 'a' }).status).toBe(
      'IGNORED',
    );
  });

  it('rejects unknown status, blank or too long note, blank or too long resolver', () => {
    const ok = { status: 'RESOLVED', note: 'n', resolvedBy: 'r' };
    expect(() => validateResolution({ ...ok, status: 'OPEN' })).toThrow(InvalidReconciliationError);
    expect(() => validateResolution({ ...ok, note: '   ' })).toThrow(InvalidReconciliationError);
    expect(() => validateResolution({ ...ok, note: 'x'.repeat(501) })).toThrow(
      InvalidReconciliationError,
    );
    expect(validateResolution({ ...ok, note: 'x'.repeat(500) }).note).toHaveLength(500);
    expect(() => validateResolution({ ...ok, resolvedBy: '' })).toThrow(InvalidReconciliationError);
    expect(() => validateResolution({ ...ok, resolvedBy: 'r'.repeat(65) })).toThrow(
      InvalidReconciliationError,
    );
  });
});
