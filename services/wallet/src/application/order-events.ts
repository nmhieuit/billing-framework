import { eventCatalog, type OrderPaidV1, type OrderPaymentFailedV1 } from '@billing/contracts';
import type { Money } from '@billing/money';
import type { NewOutboxMessage } from './ports.js';

export interface EventContext {
  tenantId: string;
  correlationId: string;
  eventId: string;
  now: Date;
}

export type PaymentFailureReason = OrderPaymentFailedV1['reason'];

/**
 * Dựng dòng outbox cho `OrderPaidV1`; payload đúng schema đã phát hành.
 * Phát lại (replay) dùng `outboxId` mới nhưng giữ nguyên `eventId` và `occurredAt` của sự kiện gốc.
 */
export function orderPaidMessage(
  ctx: EventContext,
  input: { orderId: string; walletTransactionId: string; amount: Money; paidAt: Date },
  options: { outboxId?: string; occurredAt?: Date } = {},
): NewOutboxMessage {
  const payload: OrderPaidV1 = {
    eventId: ctx.eventId,
    occurredAtUtc: (options.occurredAt ?? ctx.now).toISOString(),
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    orderId: input.orderId,
    walletTransactionId: input.walletTransactionId,
    amount: input.amount.amount,
    currency: input.amount.currency,
    paidAtUtc: input.paidAt.toISOString(),
  };
  return {
    id: options.outboxId ?? ctx.eventId,
    eventType: 'OrderPaidV1',
    routingKey: eventCatalog.OrderPaidV1.routingKey,
    payload: JSON.stringify(payload),
    correlationId: ctx.correlationId,
    createdAt: ctx.now,
  };
}

export function orderPaymentFailedMessage(
  ctx: EventContext,
  input: { orderId: string; reason: PaymentFailureReason },
): NewOutboxMessage {
  const payload: OrderPaymentFailedV1 = {
    eventId: ctx.eventId,
    occurredAtUtc: ctx.now.toISOString(),
    tenantId: ctx.tenantId,
    correlationId: ctx.correlationId,
    orderId: input.orderId,
    reason: input.reason,
  };
  return {
    id: ctx.eventId,
    eventType: 'OrderPaymentFailedV1',
    routingKey: eventCatalog.OrderPaymentFailedV1.routingKey,
    payload: JSON.stringify(payload),
    correlationId: ctx.correlationId,
    createdAt: ctx.now,
  };
}
