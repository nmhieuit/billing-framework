import { isUniqueViolation, toSafeInteger } from '@billing/database';
import { Money, type Currency } from '@billing/money';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type {
  LedgerEntryRecord,
  LedgerRepository,
  StoredLedgerTransaction,
} from '../../application/ports.js';
import type { LedgerTransaction, LedgerTransactionKind } from '../../domain/ledger-transaction.js';
import { sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyLedgerRepository implements LedgerRepository {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async post(transaction: LedgerTransaction): Promise<void> {
    const p = transaction.toProps();
    try {
      await this.db
        .insertInto('ledger_transactions')
        .values({
          id: p.id,
          business_key: p.businessKey,
          kind: p.kind,
          reverses_transaction_id: p.reversesTransactionId,
          created_at: sqlDate(p.createdAt),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(
          `ledger transaction already posted or reversed: ${p.businessKey}`,
          'ledger',
        );
      }
      throw error;
    }
    await this.db
      .insertInto('ledger_entries')
      .values(
        p.entries.map((entry) => ({
          transaction_id: p.id,
          account_id: entry.accountId,
          amount: entry.amount.amount,
          created_at: sqlDate(p.createdAt),
        })),
      )
      .execute();
  }

  async listEntries(query: {
    accountId: string;
    afterEntryId: number | null;
    limit: number;
  }): Promise<LedgerEntryRecord[]> {
    let builder = this.db
      .selectFrom('ledger_entries as e')
      .innerJoin('ledger_transactions as t', 't.id', 'e.transaction_id')
      .select([
        'e.id as entry_id',
        'e.transaction_id',
        't.business_key',
        'e.amount',
        'e.created_at',
      ])
      .where('e.account_id', '=', query.accountId);
    if (query.afterEntryId !== null) {
      builder = builder.where('e.id', '>', String(query.afterEntryId));
    }
    const rows = await builder.orderBy('e.id').top(query.limit).execute();
    return rows.map((row) => ({
      entryId: toSafeInteger(row.entry_id),
      transactionId: row.transaction_id,
      businessKey: row.business_key,
      amount: toSafeInteger(row.amount),
      createdAt: row.created_at,
    }));
  }

  async findTransaction(id: string): Promise<StoredLedgerTransaction | null> {
    const transaction = await this.db
      .selectFrom('ledger_transactions')
      .select(['id', 'kind'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!transaction) return null;
    // Đồng tiền của dòng nằm ở tài khoản, nên JOIN accounts để dựng `Money`.
    const rows = await this.db
      .selectFrom('ledger_entries as e')
      .innerJoin('accounts as a', 'a.id', 'e.account_id')
      .select(['e.account_id', 'e.amount', 'a.currency'])
      .where('e.transaction_id', '=', id)
      .orderBy('e.id')
      .execute();
    return {
      id: transaction.id,
      kind: transaction.kind as LedgerTransactionKind,
      entries: rows.map((row) => ({
        accountId: row.account_id,
        amount: Money.of(toSafeInteger(row.amount), row.currency as Currency),
      })),
    };
  }

  async findReversalOf(transactionId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom('ledger_transactions')
      .select('id')
      .where('reverses_transaction_id', '=', transactionId)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
