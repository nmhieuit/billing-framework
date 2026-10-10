import { dateTime, toSafeInteger } from '@billing/database';
import { Money, type Currency } from '@billing/money';
import type { Insertable, Selectable } from 'kysely';
import { Charge } from '../../domain/charge.js';
import type { ChargeStatus } from '../../domain/charge.js';
import { hasMetadata, parseStoredMetadata } from '../../domain/metadata.js';
import type { Scenario } from '../../domain/scenario.js';
import { WebhookEvent } from '../../domain/webhook-event.js';
import type { WebhookEventStatus, WebhookEventType } from '../../domain/webhook-event.js';
import type { ChargesTable, WebhookEventsTable } from './schema.js';

export function chargeToRow(charge: Charge): Insertable<ChargesTable> {
  const p = charge.toProps();
  return {
    id: p.id,
    reference: p.reference,
    amount: p.amount.amount,
    currency: p.amount.currency,
    status: p.status,
    failure_code: p.failureCode,
    scenario: JSON.stringify(p.scenario),
    metadata: hasMetadata(p.metadata) ? JSON.stringify(p.metadata) : null,
    due_at: dateTime(p.dueAt) as unknown as Date,
    created_at: dateTime(p.createdAt) as unknown as Date,
    completed_at: p.completedAt === null ? null : (dateTime(p.completedAt) as unknown as Date),
  };
}

export function rowToCharge(row: Selectable<ChargesTable>): Charge {
  return Charge.rehydrate({
    id: row.id,
    reference: row.reference,
    amount: Money.of(toSafeInteger(row.amount), row.currency as Currency),
    status: row.status as ChargeStatus,
    failureCode: row.failure_code,
    scenario: JSON.parse(row.scenario) as Scenario,
    metadata: parseStoredMetadata(row.metadata),
    dueAt: row.due_at,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  });
}

export function webhookToRow(event: WebhookEvent): Insertable<WebhookEventsTable> {
  const p = event.toProps();
  return {
    event_id: p.eventId,
    charge_id: p.chargeId,
    event_type: p.type,
    payload: p.payload,
    status: p.status,
    attempts: p.attempts,
    next_attempt_at:
      p.nextAttemptAt === null ? null : (dateTime(p.nextAttemptAt) as unknown as Date),
    send_twice: p.sendTwice,
    created_at: dateTime(p.createdAt) as unknown as Date,
    delivered_at: p.deliveredAt === null ? null : (dateTime(p.deliveredAt) as unknown as Date),
  };
}

export function rowToWebhook(row: Selectable<WebhookEventsTable>): WebhookEvent {
  return WebhookEvent.rehydrate({
    eventId: row.event_id,
    chargeId: row.charge_id,
    type: row.event_type as WebhookEventType,
    payload: row.payload,
    status: row.status as WebhookEventStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    sendTwice: row.send_twice,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  });
}
