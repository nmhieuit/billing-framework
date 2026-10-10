import { dateTime } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { NewOutboxMessage, OutboxMessage, OutboxRepository } from '../../application/ports.js';
import { outboxToRow, rowToOutbox, sqlDate } from './mappers.js';
import type { OutboxTable, WalletDatabase } from './schema.js';

const COLUMNS = sql.raw(
  'id, event_type, routing_key, payload, correlation_id, status, attempts, next_attempt_at, created_at, sent_at',
);

export class KyselyOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: Kysely<WalletDatabase>,
    private readonly schema: string,
  ) {}

  async add(message: NewOutboxMessage): Promise<void> {
    await this.db.insertInto('outbox').values(outboxToRow(message)).execute();
  }

  async lockNextDue(now: Date): Promise<OutboxMessage | null> {
    // Cần index ix_outbox_due (status, next_attempt_at, id) khớp ORDER BY để READPAST bỏ qua đúng dòng bị khóa.
    const result = await sql<Selectable<OutboxTable>>`
      select top (1) ${COLUMNS}
      from ${sql.id(this.schema, 'outbox')} with (updlock, readpast, rowlock)
      where status = ${'PENDING'} and next_attempt_at <= ${dateTime(now)}
      order by next_attempt_at, id`.execute(this.db);
    const row = result.rows[0];
    return row ? rowToOutbox(row) : null;
  }

  async lease(id: string, until: Date): Promise<void> {
    await this.db
      .updateTable('outbox')
      .set({ next_attempt_at: sqlDate(until) })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .execute();
  }

  async markSent(id: string, sentAt: Date): Promise<void> {
    await this.db
      .updateTable('outbox')
      .set({ status: 'SENT', sent_at: sqlDate(sentAt) })
      .where('id', '=', id)
      .execute();
  }

  async recordFailure(id: string, nextAttemptAt: Date): Promise<void> {
    await this.db
      .updateTable('outbox')
      .set({ attempts: sql<number>`attempts + 1`, next_attempt_at: sqlDate(nextAttemptAt) })
      .where('id', '=', id)
      .where('status', '=', 'PENDING')
      .execute();
  }
}
