import { isUniqueViolation, toSafeInteger } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { LedgerEntryRecord, LedgerRepository } from '../../application/ports.js';
import type { LedgerTransaction } from '../../domain/ledger-transaction.js';
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
          created_at: sqlDate(p.createdAt),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`business key already posted: ${p.businessKey}`);
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
}
