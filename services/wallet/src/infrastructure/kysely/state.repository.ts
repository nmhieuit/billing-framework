import { sql, type Kysely } from 'kysely';
import type { StateRepository, StateSnapshot } from '../../application/ports.js';
import type { WalletDatabase } from './schema.js';

/** Đọc số liệu trạng thái (đếm và mốc cũ nhất) của một tenant cho các gauge; chỉ đọc, không khóa dòng. */
export class KyselyStateRepository implements StateRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async snapshot(): Promise<StateSnapshot> {
    const t = (name: string) => sql.id(this.schema, name);
    const outbox = await sql<{ pending: number; oldest: Date | null }>`
      select count(*) as pending, min(created_at) as oldest
      from ${t('outbox')} where status = 'PENDING'`.execute(this.db);
    const topups = await sql<{ requested: number; oldest: Date | null }>`
      select count(*) as requested, min(created_at) as oldest
      from ${t('topups')} where status = 'REQUESTED'`.execute(this.db);
    const open = await sql<{ kind: string; total: number; oldest: Date | null }>`
      select kind, count(*) as total, min(created_at) as oldest
      from ${t('reconciliation_items')} where case_status = 'OPEN' group by kind`.execute(this.db);
    const last = await sql<{ at: Date | null }>`
      select max(finished_at) as at from ${t('reconciliation_runs')} where status = 'COMPLETED'`.execute(
      this.db,
    );

    const openRows = open.rows;
    const oldestOpen = openRows.flatMap((row) => (row.oldest ? [row.oldest.getTime()] : []));
    return {
      outboxPending: Number(outbox.rows[0]?.pending ?? 0),
      outboxOldestCreatedAt: outbox.rows[0]?.oldest ?? null,
      topupsRequested: Number(topups.rows[0]?.requested ?? 0),
      topupsOldestCreatedAt: topups.rows[0]?.oldest ?? null,
      openItemsByKind: Object.fromEntries(openRows.map((row) => [row.kind, Number(row.total)])),
      oldestOpenItemCreatedAt: oldestOpen.length > 0 ? new Date(Math.min(...oldestOpen)) : null,
      lastReconciliationSuccessAt: last.rows[0]?.at ?? null,
    };
  }
}
