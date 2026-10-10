import { isUniqueViolation } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { AccountRepository } from '../../application/ports.js';
import type { Account } from '../../domain/account.js';
import { accountToRow, rowToAccount } from './mappers.js';
import type { AccountsTable, WalletDatabase } from './schema.js';

export class KyselyAccountRepository implements AccountRepository {
  /** `db` đã gắn schema tenant (`withSchema`); `schema` dùng cho các câu SQL thô. */
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async find(id: string): Promise<Account | null> {
    const row = await this.db
      .selectFrom('accounts')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToAccount(row) : null;
  }

  async insert(account: Account): Promise<void> {
    try {
      await this.db.insertInto('accounts').values(accountToRow(account)).execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`account already exists: ${account.toProps().id}`);
      }
      throw error;
    }
  }

  async lockMany(ids: readonly string[]): Promise<Account[]> {
    // Khóa tuần tự theo id tăng dần: thứ tự cố định nên hai giao dịch chạm cùng ví không deadlock.
    const sorted = [...new Set(ids)].sort();
    const locked: Account[] = [];
    for (const id of sorted) {
      const result = await sql<Selectable<AccountsTable>>`
        select id, kind, customer_id, currency, balance, created_at
        from ${sql.id(this.schema, 'accounts')} with (updlock, rowlock)
        where id = ${id}`.execute(this.db);
      const row = result.rows[0];
      if (!row) throw new Error(`account not found: ${id}`);
      locked.push(rowToAccount(row));
    }
    return locked;
  }

  async saveBalance(account: Account): Promise<void> {
    const row = accountToRow(account);
    await this.db
      .updateTable('accounts')
      .set({ balance: row.balance })
      .where('id', '=', row.id)
      .execute();
  }
}
