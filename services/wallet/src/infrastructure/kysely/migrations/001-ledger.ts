import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Tài khoản, giao dịch và dòng bút toán; sổ cái bất biến bằng trigger. Chạy trong schema của một tenant. */
export const ledgerMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    await sql`
      create table ${t('accounts')} (
        id nvarchar(80) not null primary key,
        kind nvarchar(16) not null,
        customer_id nvarchar(64) null,
        currency nvarchar(3) not null,
        balance bigint not null,
        created_at datetime2(3) not null,
        constraint ck_accounts_kind check (kind in ('WALLET', 'GATEWAY', 'MERCHANT')),
        constraint ck_accounts_currency check (currency in ('VND', 'USD')),
        constraint ck_accounts_balance check (
          (kind = 'WALLET' and balance >= 0)
          or (kind = 'GATEWAY' and balance <= 0)
          or (kind = 'MERCHANT' and balance >= 0)
        )
      )`.execute(db);

    await sql`
      create table ${t('ledger_transactions')} (
        id nvarchar(64) not null primary key,
        business_key nvarchar(200) not null,
        kind nvarchar(16) not null,
        created_at datetime2(3) not null,
        constraint uq_ledger_transactions_business_key unique (business_key),
        constraint ck_ledger_transactions_kind check (kind in ('TOPUP'))
      )`.execute(db);

    await sql`
      create table ${t('ledger_entries')} (
        id bigint identity(1, 1) not null primary key,
        transaction_id nvarchar(64) not null references ${t('ledger_transactions')} (id),
        account_id nvarchar(80) not null references ${t('accounts')} (id),
        amount bigint not null,
        created_at datetime2(3) not null,
        constraint ck_ledger_entries_amount check (amount <> 0)
      )`.execute(db);
    await sql`create index ix_ledger_entries_account on ${t('ledger_entries')} (account_id, id)`.execute(
      db,
    );
    await sql`create index ix_ledger_entries_transaction on ${t('ledger_entries')} (transaction_id)`.execute(
      db,
    );

    // Sổ cái chỉ được ghi thêm: chặn sửa/xóa ở mức DB bất kể ai có quyền.
    for (const table of ['ledger_entries', 'ledger_transactions']) {
      await sql`
        create trigger ${t(`trg_${table}_immutable`)} on ${t(table)}
        instead of update, delete
        as begin
          throw 50001, 'ledger is immutable', 1;
        end`.execute(db);
    }

    // Tài khoản hệ thống theo từng đồng tiền.
    for (const currency of ['VND', 'USD']) {
      for (const kind of ['GATEWAY', 'MERCHANT']) {
        await sql`
          insert into ${t('accounts')} (id, kind, customer_id, currency, balance, created_at)
          values (${`system:${kind}:${currency}`}, ${kind}, null, ${currency}, 0,
                  cast(sysutcdatetime() as datetime2(3)))`.execute(db);
      }
    }
  },
});
