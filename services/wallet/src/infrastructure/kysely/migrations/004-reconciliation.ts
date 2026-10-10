import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Đối soát: các lượt chạy (bất biến) và các dòng lệch kèm trạng thái ca. Chạy trong schema của một tenant. */
export const reconciliationMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);

    await sql`
      create table ${t('reconciliation_runs')} (
        id nvarchar(64) not null primary key,
        run_day nvarchar(10) not null,
        status nvarchar(10) not null,
        triggered_by nvarchar(10) not null,
        failure_reason nvarchar(500) null,
        gateway_totals nvarchar(max) not null,
        wallet_totals nvarchar(max) not null,
        item_count int not null,
        started_at datetime2(3) not null,
        finished_at datetime2(3) null,
        constraint ck_reconciliation_runs_status check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
        constraint ck_reconciliation_runs_triggered_by check (triggered_by in ('SCHEDULED', 'MANUAL'))
      )`.execute(db);
    // Mỗi ngày chỉ một lượt định kỳ chưa thất bại: worker chạy song song hay chạy lại không tạo lượt trùng.
    await sql`
      create unique index uq_reconciliation_runs_scheduled on ${t('reconciliation_runs')} (run_day)
      where triggered_by = 'SCHEDULED' and status <> 'FAILED'`.execute(db);
    await sql`create index ix_reconciliation_runs_day on ${t('reconciliation_runs')} (run_day, started_at)`.execute(
      db,
    );

    await sql`
      create table ${t('reconciliation_items')} (
        seq bigint identity(1, 1) not null primary key,
        id nvarchar(64) not null,
        run_id nvarchar(64) not null references ${t('reconciliation_runs')} (id),
        kind nvarchar(24) not null,
        charge_id nvarchar(64) null,
        topup_id nvarchar(64) null,
        amount_gateway bigint null,
        amount_wallet bigint null,
        currency nvarchar(3) null,
        detail nvarchar(max) not null,
        action nvarchar(16) not null,
        case_status nvarchar(10) not null,
        resolved_by nvarchar(64) null,
        resolution_note nvarchar(500) null,
        resolved_at datetime2(3) null,
        created_at datetime2(3) not null,
        constraint uq_reconciliation_items_id unique (id),
        constraint ck_reconciliation_items_kind check (kind in (
          'LEDGER_UNBALANCED', 'BALANCE_MISMATCH', 'MISSING_AT_WALLET', 'UNKNOWN_CHARGE',
          'MISSING_AT_GATEWAY', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH')),
        constraint ck_reconciliation_items_action check (action in ('NONE', 'AUTO_APPLIED', 'FAILED_AUTOFIX')),
        constraint ck_reconciliation_items_case_status check (case_status in ('OPEN', 'RESOLVED', 'IGNORED'))
      )`.execute(db);
    await sql`create index ix_reconciliation_items_run on ${t('reconciliation_items')} (run_id, case_status, seq)`.execute(
      db,
    );
  },
});
