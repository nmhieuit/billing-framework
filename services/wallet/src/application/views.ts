import type { Account } from '../domain/account.js';
import type { Topup, TopupStatus } from '../domain/topup.js';
import type { LedgerEntryRecord } from './ports.js';

export interface WalletView {
  customerId: string;
  currency: string;
  balance: number;
  createdAt: string;
}

export function toWalletView(account: Account): WalletView {
  const p = account.toProps();
  return {
    customerId: p.customerId ?? '',
    currency: p.currency,
    balance: p.balance.amount,
    createdAt: p.createdAt.toISOString(),
  };
}

export interface TopupCreatedView {
  topupId: string;
  status: 'REQUESTED';
  amount: number;
  currency: string;
  createdAt: string;
}

export function toTopupCreatedView(topup: Topup): TopupCreatedView {
  const p = topup.toProps();
  return {
    topupId: p.id,
    status: 'REQUESTED',
    amount: p.amount.amount,
    currency: p.amount.currency,
    createdAt: p.createdAt.toISOString(),
  };
}

export interface TopupView {
  topupId: string;
  status: TopupStatus;
  amount: number;
  currency: string;
  failureCode?: string;
  createdAt: string;
  completedAt?: string;
}

export function toTopupView(topup: Topup): TopupView {
  const p = topup.toProps();
  return {
    topupId: p.id,
    status: p.status,
    amount: p.amount.amount,
    currency: p.amount.currency,
    ...(p.failureCode === null ? {} : { failureCode: p.failureCode }),
    createdAt: p.createdAt.toISOString(),
    ...(p.completedAt === null ? {} : { completedAt: p.completedAt.toISOString() }),
  };
}

export interface EntryView {
  entryId: number;
  transactionId: string;
  businessKey: string;
  amount: number;
  createdAt: string;
}

export function toEntryView(record: LedgerEntryRecord): EntryView {
  return {
    entryId: record.entryId,
    transactionId: record.transactionId,
    businessKey: record.businessKey,
    amount: record.amount,
    createdAt: record.createdAt.toISOString(),
  };
}
