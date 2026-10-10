import type { Charge, ChargeStatus } from '../domain/charge.js';
import { hasMetadata, type Metadata } from '../domain/metadata.js';

export interface ChargeCreatedView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: 'PENDING';
  metadata?: Metadata;
  createdAt: string;
}

export interface ChargeView {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: ChargeStatus;
  failureCode?: string;
  metadata?: Metadata;
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
    ...(hasMetadata(p.metadata) ? { metadata: p.metadata } : {}),
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
    ...(hasMetadata(p.metadata) ? { metadata: p.metadata } : {}),
    createdAt: p.createdAt.toISOString(),
    ...(p.completedAt === null ? {} : { completedAt: p.completedAt.toISOString() }),
  };
}
