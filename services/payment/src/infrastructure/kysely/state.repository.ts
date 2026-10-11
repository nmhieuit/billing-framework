import { sql, type Kysely } from 'kysely';
import type { StateRepository, StateSnapshot } from '../../application/ports.js';
import type { PaymentDatabase } from './schema.js';

/** Đọc số liệu backlog webhook (đếm và mốc cũ nhất) cho các gauge; chỉ đọc, không khóa dòng. */
export class KyselyStateRepository implements StateRepository {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async snapshot(): Promise<StateSnapshot> {
    const result = await sql<{ pending: number; oldest: Date | null }>`
      select count(*) as pending, min(created_at) as oldest
      from webhook_events where status = 'PENDING'`.execute(this.db);
    const row = result.rows[0];
    return {
      webhookPending: Number(row?.pending ?? 0),
      webhookOldestCreatedAt: row?.oldest ?? null,
    };
  }
}
