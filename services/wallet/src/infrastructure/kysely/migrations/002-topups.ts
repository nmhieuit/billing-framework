import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Lần nạp tiền, idempotency key của API và inbox khử trùng webhook. Chạy trong schema của một tenant. */
export const topupsMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    await sql`
      create table ${t('topups')} (
        id nvarchar(64) not null primary key,
        customer_id nvarchar(64) not null,
        account_id nvarchar(80) not null references ${t('accounts')} (id),
        amount bigint not null,
        currency nvarchar(3) not null,
        status nvarchar(16) not null,
        charge_id nvarchar(64) null,
        failure_code nvarchar(64) null,
        attempts int not null,
        next_attempt_at datetime2(3) null,
        created_at datetime2(3) not null,
        completed_at datetime2(3) null,
        constraint ck_topups_amount check (amount > 0),
        constraint ck_topups_currency check (currency in ('VND', 'USD')),
        constraint ck_topups_status check (status in ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED'))
      )`.execute(db);
    // Index (status, next_attempt_at, id) là BẮT BUỘC cho `top (1) ... with (updlock, readpast)` của worker.
    await sql`create index ix_topups_due on ${t('topups')} (status, next_attempt_at, id)`.execute(
      db,
    );
    await sql`create index ix_topups_customer on ${t('topups')} (customer_id, created_at)`.execute(
      db,
    );

    await sql`
      create table ${t('idempotency_keys')} (
        customer_id nvarchar(64) not null,
        idempotency_key nvarchar(255) collate Latin1_General_100_BIN2 not null,
        request_hash nvarchar(64) not null,
        response_status int not null,
        response_body nvarchar(max) not null,
        topup_id nvarchar(64) not null references ${t('topups')} (id),
        created_at datetime2(3) not null,
        primary key (customer_id, idempotency_key)
      )`.execute(db);

    await sql`
      create table ${t('processed_messages')} (
        consumer nvarchar(64) not null,
        message_id nvarchar(128) not null,
        processed_at datetime2(3) not null,
        primary key (consumer, message_id)
      )`.execute(db);
  },
});
