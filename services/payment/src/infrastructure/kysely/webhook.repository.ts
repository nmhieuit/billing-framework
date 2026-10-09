import { dateTime } from '@billing/database';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { WebhookAttemptRecord, WebhookOutbox } from '../../application/ports.js';
import type { WebhookEvent } from '../../domain/webhook-event.js';
import { rowToWebhook, webhookToRow } from './mappers.js';
import type { PaymentDatabase, WebhookEventsTable } from './schema.js';

const MAX_ERROR_LENGTH = 500;

export class KyselyWebhookOutbox implements WebhookOutbox {
  constructor(private readonly db: Kysely<PaymentDatabase>) {}

  async add(event: WebhookEvent): Promise<void> {
    await this.db.insertInto('webhook_events').values(webhookToRow(event)).execute();
  }

  async lockDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    // Cần index ix_webhook_due (status, next_attempt_at, event_id) để READPAST hoạt động đúng.
    const result = await sql<Selectable<WebhookEventsTable>>`
      select top (${limit}) event_id, charge_id, event_type, payload, status, attempts,
             next_attempt_at, send_twice, created_at, delivered_at
      from webhook_events with (updlock, readpast, rowlock)
      where status = ${'PENDING'} and next_attempt_at <= ${dateTime(now)}
      order by next_attempt_at, event_id`.execute(this.db);
    return result.rows.map(rowToWebhook);
  }

  async save(event: WebhookEvent): Promise<void> {
    const row = webhookToRow(event);
    await this.db
      .updateTable('webhook_events')
      .set({
        status: row.status,
        attempts: row.attempts,
        next_attempt_at: row.next_attempt_at ?? null,
        delivered_at: row.delivered_at ?? null,
      })
      .where('event_id', '=', row.event_id)
      .execute();
  }

  async recordAttempt(attempt: WebhookAttemptRecord): Promise<void> {
    await this.db
      .insertInto('webhook_attempts')
      .values({
        event_id: attempt.eventId,
        attempt_no: attempt.attemptNo,
        attempted_at: dateTime(attempt.attemptedAt) as unknown as Date,
        status_code: attempt.statusCode,
        error_message: attempt.error === null ? null : attempt.error.slice(0, MAX_ERROR_LENGTH),
      })
      .execute();
  }
}
