import { sql, type Kysely } from 'kysely';

/** Index cho các câu xóa của job retention (không quét cả bảng). */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index ix_webhook_delivered on webhook_events (delivered_at) where status = 'DELIVERED'`.execute(
    db,
  );
  await sql`create index ix_payment_idempotency_created on idempotency_keys (created_at)`.execute(
    db,
  );
}
