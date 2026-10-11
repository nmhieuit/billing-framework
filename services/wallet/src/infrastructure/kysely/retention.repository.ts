import { dateTime } from '@billing/database';
import { sql, type Kysely, type RawBuilder } from 'kysely';
import {
  DRY_RUN_COUNT_CAP,
  type RetentionRepository,
  type WalletRetentionPolicy,
} from '../../application/retention.js';
import type { WalletDatabase } from './schema.js';

/** Mọi bảng mà từng chính sách đọc hoặc ghi; test bảo vệ khẳng định không có bảng tài chính nào ở đây. */
export const RETENTION_TARGET_TABLES: Record<WalletRetentionPolicy, readonly string[]> = {
  reconciliation_items: ['reconciliation_items'],
  reconciliation_runs: ['reconciliation_runs', 'reconciliation_items'],
  outbox_sent: ['outbox'],
  processed_messages: ['processed_messages'],
  idempotency_keys: ['idempotency_keys'],
};

export class KyselyRetentionRepository implements RetentionRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async purge(
    policy: WalletRetentionPolicy,
    cutoff: Date,
    batchSize: number,
    dryRun: boolean,
  ): Promise<number> {
    const t = (name: string) => sql.id(this.schema, name);
    const at = dateTime(cutoff);
    // `from` + `where` của từng chính sách; dùng chung cho đếm và xóa để hai chế độ không lệch nhau.
    const spec = ((): { target: RawBuilder<unknown>; where: RawBuilder<unknown> } => {
      switch (policy) {
        case 'reconciliation_items':
          return {
            target: sql`${t('reconciliation_items')} as x`,
            where: sql`x.case_status in ('RESOLVED', 'IGNORED') and x.created_at < ${at}`,
          };
        case 'reconciliation_runs':
          return {
            target: sql`${t('reconciliation_runs')} as x`,
            where: sql`x.status <> 'RUNNING' and x.finished_at < ${at}
              and not exists (select 1 from ${t('reconciliation_items')} i where i.run_id = x.id)`,
          };
        case 'outbox_sent':
          return {
            target: sql`${t('outbox')} as x`,
            where: sql`x.status = 'SENT' and x.sent_at < ${at}`,
          };
        case 'processed_messages':
          return {
            target: sql`${t('processed_messages')} as x`,
            where: sql`x.processed_at < ${at}`,
          };
        case 'idempotency_keys':
          return {
            target: sql`${t('idempotency_keys')} as x`,
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
