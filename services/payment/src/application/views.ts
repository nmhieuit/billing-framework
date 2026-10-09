import type { Charge, ChargeStatus } from '../domain/charge.js';

export interface ChargeCreatedView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: 'PENDING';
  createdAt: string;
}

export interface ChargeView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: ChargeStatus;
  failureCode?: string;
  createdAt: string;
  completedAt?: string;
}

export function toCreatedView(charge: Charge): ChargeCreatedView {
  const p = charge.toProps();
  return {
    chargeId: p.id,
    reference: p.reference,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: 'PENDING',
    createdAt: p.createdAt.toISOString(),
  };
}

export function toChargeView(charge: Charge): ChargeView {
  const p = charge.toProps();
  return {
    chargeId: p.id,
    reference: p.reference,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: p.status,
    ...(p.failureCode === null ? {} : { failureCode: p.failureCode }),
    createdAt: p.createdAt.toISOString(),
    ...(p.completedAt === null ? {} : { completedAt: p.completedAt.toISOString() }),
  };
}
