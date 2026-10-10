import { dateTime, toSafeInteger } from '@billing/database';
import { Money, type Currency } from '@billing/money';
import type { Insertable, Selectable } from 'kysely';
import { Account, type AccountKind } from '../../domain/account.js';
import { Topup, type TopupStatus } from '../../domain/topup.js';
import type { AccountsTable, TopupsTable } from './schema.js';

/** `dateTime()` là biểu thức SQL; Kysely chấp nhận biểu thức ở mọi chỗ cần giá trị Date. */
export const sqlDate = (value: Date): Date => dateTime(value) as unknown as Date;
export const sqlDateOrNull = (value: Date | null): Date | null =>
  value === null ? null : sqlDate(value);

export function accountToRow(account: Account): Insertable<AccountsTable> {
  const p = account.toProps();
  return {
    id: p.id,
    kind: p.kind,
    customer_id: p.customerId,
    currency: p.currency,
    balance: p.balance.amount,
    created_at: sqlDate(p.createdAt),
  };
}

export function rowToAccount(row: Selectable<AccountsTable>): Account {
  const currency = row.currency as Currency;
  return Account.rehydrate({
    id: row.id,
    kind: row.kind as AccountKind,
    customerId: row.customer_id,
    currency,
    balance: Money.of(toSafeInteger(row.balance), currency),
    createdAt: row.created_at,
  });
}

export function topupToRow(topup: Topup): Insertable<TopupsTable> {
  const p = topup.toProps();
  return {
    id: p.id,
    customer_id: p.customerId,
    account_id: p.accountId,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: p.status,
    charge_id: p.chargeId,
    failure_code: p.failureCode,
    attempts: p.attempts,
    next_attempt_at: sqlDateOrNull(p.nextAttemptAt),
    created_at: sqlDate(p.createdAt),
    completed_at: sqlDateOrNull(p.completedAt),
  };
}

export function rowToTopup(row: Selectable<TopupsTable>): Topup {
  return Topup.rehydrate({
    id: row.id,
    customerId: row.customer_id,
    accountId: row.account_id,
    amount: Money.of(toSafeInteger(row.amount), row.currency as Currency),
    status: row.status as TopupStatus,
    chargeId: row.charge_id,
    failureCode: row.failure_code,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}
