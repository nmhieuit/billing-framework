import type { Migration } from '@billing/database';
import { sql, type Kysely } from 'kysely';
import { assertSchemaName } from '../schema-name.js';

/** Index cho các câu xóa của job retention (không quét cả bảng). Chạy trong schema của một tenant. */
export const retentionIndexesMigration = (schemaArg: string): Migration => ({
  async up(db: Kysely<unknown>): Promise<void> {
    const schema = assertSchemaName(schemaArg);
    const t = (name: string) => sql.id(schema, name);
    await sql`create index ix_outbox_sent on ${t('outbox')} (sent_at) where status = 'SENT'`.execute(
      db,
    );
    await sql`create index ix_processed_messages_at on ${t('processed_messages')} (processed_at)`.execute(
      db,
    );
    await sql`create index ix_idempotency_keys_created on ${t('idempotency_keys')} (created_at)`.execute(
      db,
    );
  },
});
