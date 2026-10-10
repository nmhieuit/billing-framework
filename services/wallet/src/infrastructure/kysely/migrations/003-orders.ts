import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Trả order từ ví: mở rộng loại giao dịch ledger, ghi nhớ order đã trả và outbox. Chạy trong schema của một tenant. */
export const ordersMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    // Đã kiểm chứng: drop + add trên bảng có dữ liệu và trigger bất biến; ràng buộc vẫn "trusted".
    await sql`alter table ${t('ledger_transactions')} drop constraint ck_ledger_transactions_kind`.execute(
      db,
    );
    await sql`
      alter table ${t('ledger_transactions')}
      add constraint ck_ledger_transactions_kind check (kind in ('TOPUP', 'ORDER_PAYMENT'))`.execute(
      db,
    );

    await sql`
      create table ${t('order_payments')} (
        order_id nvarchar(64) not null primary key,
        customer_id nvarchar(64) not null,
        wallet_transaction_id nvarchar(64) not null references ${t('ledger_transactions')} (id),
        amount bigint not null,
        currency nvarchar(3) not null,
        paid_at datetime2(3) not null,
        constraint ck_order_payments_amount check (amount > 0),
        constraint ck_order_payments_currency check (currency in ('VND', 'USD'))
      )`.execute(db);

    await sql`
      create table ${t('outbox')} (
        id nvarchar(64) not null primary key,
        event_type nvarchar(64) not null,
        routing_key nvarchar(100) not null,
        payload nvarchar(max) not null,
        correlation_id nvarchar(100) not null,
        status nvarchar(8) not null,
        attempts int not null,
        next_attempt_at datetime2(3) not null,
        created_at datetime2(3) not null,
        sent_at datetime2(3) null,
        constraint ck_outbox_status check (status in ('PENDING', 'SENT'))
      )`.execute(db);
    // Index (status, next_attempt_at, id) là BẮT BUỘC cho `top (1) ... with (updlock, readpast)` của relay.
    await sql`create index ix_outbox_due on ${t('outbox')} (status, next_attempt_at, id)`.execute(
      db,
    );
  },
});
