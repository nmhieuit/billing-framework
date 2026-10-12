import { dateTime } from '@billing/database';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  DRY_RUN_COUNT_CAP,
  type PaymentRetentionPolicy,
  type RetentionRepository,
} from '../../application/retention.js';
import type { PaymentDatabase } from './schema.js';

/** Mọi bảng mà từng chính sách đọc hoặc ghi; test bảo vệ khẳng định `charges` không nằm ở đây. */
export const RETENTION_TARGET_TABLES: Record<PaymentRetentionPolicy, readonly string[]> = {
  webhook_attempts: ['webhook_attempts', 'webhook_events'],
  webhook_events: ['webhook_events', 'webhook_attempts'],
  idempotency_keys: ['idempotency_keys'],
};

export class KyselyRetentionRepository implements RetentionRepository {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async purge(
    policy: PaymentRetentionPolicy,
    cutoff: Date,
    batchSize: number,
    dryRun: boolean,
  ): Promise<number> {
    const at = dateTime(cutoff);
    // `from` + `where` của từng chính sách; dùng chung cho đếm và xóa để hai chế độ không lệch nhau.
    const spec = ((): { target: RawBuilder<unknown>; where: RawBuilder<unknown> } => {
      switch (policy) {
        case 'webhook_attempts':
          return {
            target: sql`webhook_attempts as x`,
            where: sql`x.event_id in (
              select e.event_id from webhook_events e
              where e.status = 'DELIVERED' and e.delivered_at < ${at})`,
          };
        case 'webhook_events':
          // Chỉ xóa khi không còn attempt nào (khóa ngoại), nên phải chạy sau `webhook_attempts`.
          return {
            target: sql`webhook_events as x`,
            where: sql`x.status = 'DELIVERED' and x.delivered_at < ${at}
              and not exists (select 1 from webhook_attempts a where a.event_id = x.event_id)`,
          };
        case 'idempotency_keys':
          return {
            target: sql`idempotency_keys as x`,
            where: sql`x.created_at < ${at}`,
          };
      }
    })();

    if (dryRun) {
      const result = await sql<{ total: number }>`
        select count(*) as total from (
          select top (${sql.lit(DRY_RUN_COUNT_CAP)}) 1 as one
          from ${spec.target} where ${spec.where}
        ) counted`.execute(this.db);
      return Number(result.rows[0]?.total ?? 0);
    }
    const result = await sql`
      delete top (${sql.lit(batchSize)}) x
      from ${spec.target} with (readpast, rowlock)
      where ${spec.where}`.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }
}
