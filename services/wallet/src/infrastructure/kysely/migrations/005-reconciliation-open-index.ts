import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Index cho truy vấn gauge "mục đối soát đang mở" (không quét cả bảng). Chạy trong schema của một tenant. */
export const reconciliationOpenIndexMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    await sql`
      create index ix_reconciliation_items_open
      on ${sql.id(schema, 'reconciliation_items')} (case_status, kind) include (created_at)`.execute(
      db,
    );
  },
});
