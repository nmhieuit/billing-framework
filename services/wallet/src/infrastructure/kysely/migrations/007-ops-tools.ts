import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Công cụ vận hành: đóng băng ví, điều chỉnh, đảo giao dịch, phát lại OrderPaid và nhật ký kiểm toán. Chạy trong schema của một tenant. */
export const opsToolsMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    // Đóng băng ví + loại tài khoản ADJUSTMENT (số dư không ràng buộc dấu).
    await sql`
      alter table ${t('accounts')} add
        frozen_at datetime2(3) null,
        frozen_by nvarchar(100) null,
        frozen_reason nvarchar(500) null`.execute(db);
    await sql`alter table ${t('accounts')} drop constraint ck_accounts_kind`.execute(db);
    await sql`alter table ${t('accounts')} drop constraint ck_accounts_balance`.execute(db);
    await sql`
      alter table ${t('accounts')} add constraint ck_accounts_kind
      check (kind in ('WALLET', 'GATEWAY', 'MERCHANT', 'ADJUSTMENT'))`.execute(db);
    await sql`
      alter table ${t('accounts')} add constraint ck_accounts_balance check (
        (kind = 'WALLET' and balance >= 0)
        or (kind = 'GATEWAY' and balance <= 0)
        or (kind = 'MERCHANT' and balance >= 0)
        or kind = 'ADJUSTMENT')`.execute(db);
    await sql`
      alter table ${t('accounts')} add constraint ck_accounts_frozen
      check (frozen_at is null or kind = 'WALLET')`.execute(db);
    for (const currency of ['VND', 'USD']) {
      await sql`
        insert into ${t('accounts')} (id, kind, customer_id, currency, balance, created_at)
        values (${`system:ADJUSTMENT:${currency}`}, 'ADJUSTMENT', null, ${currency}, 0,
                cast(sysutcdatetime() as datetime2(3)))`.execute(db);
    }

    // Loại giao dịch mới + liên kết đảo (mỗi giao dịch chỉ bị đảo một lần).
    await sql`alter table ${t('ledger_transactions')} drop constraint ck_ledger_transactions_kind`.execute(
      db,
    );
    await sql`
      alter table ${t('ledger_transactions')} add constraint ck_ledger_transactions_kind
      check (kind in ('TOPUP', 'ORDER_PAYMENT', 'ADJUSTMENT', 'REVERSAL'))`.execute(db);
    await sql`
      alter table ${t('ledger_transactions')} add
        reverses_transaction_id nvarchar(64) null
        constraint fk_ledger_transactions_reverses references ${t('ledger_transactions')} (id)`.execute(
      db,
    );
    await sql`
      create unique index ux_ledger_transactions_reverses
      on ${t('ledger_transactions')} (reverses_transaction_id)
      where reverses_transaction_id is not null`.execute(db);

    // eventId của OrderPaidV1 ban đầu (để phát lại giữ nguyên eventId); dòng outbox gốc có thể đã bị retention dọn.
    await sql`alter table ${t('order_payments')} add paid_event_id nvarchar(64) null`.execute(db);
    await sql`
      update op set paid_event_id = o.event_id
      from ${t('order_payments')} op
      cross apply (
        select top (1) json_value(x.payload, '$.eventId') as event_id
        from ${t('outbox')} x
        where x.event_type = 'OrderPaidV1' and json_value(x.payload, '$.orderId') = op.order_id
        order by x.created_at asc
      ) o
      where op.paid_event_id is null`.execute(db);

    // Nhật ký kiểm toán dùng chung; chỉ thêm.
    await sql`
      create table ${t('ops_actions')} (
        seq bigint identity(1, 1) not null primary key,
        id nvarchar(64) not null,
        action nvarchar(16) not null,
        actor nvarchar(100) not null,
        reason nvarchar(500) not null,
        target nvarchar(200) not null,
        idempotency_key nvarchar(200) not null,
        fingerprint nvarchar(64) not null,
        result nvarchar(max) not null,
        created_at datetime2(3) not null,
        constraint uq_ops_actions_id unique (id),
        constraint uq_ops_actions_key unique (idempotency_key),
        constraint ck_ops_actions_action
          check (action in ('FREEZE', 'UNFREEZE', 'ADJUST', 'REVERSE', 'REPLAY_PAID'))
      )`.execute(db);
    await sql`
      create trigger ${t('trg_ops_actions_append_only')} on ${t('ops_actions')}
      instead of update, delete
      as begin
        throw 50002, 'ops_actions is append-only', 1;
      end`.execute(db);
  },
});
