import type { HandlerResult, IncomingMessage, MessageHandler } from '@billing/messaging';
import { MissingTenantError, UnknownTenantError } from '../../application/errors.js';
import type { PayOrder } from '../../application/pay-order.js';
import type { Logger, TenantRegistry } from '../../application/ports.js';
import type { TenantId } from '../../domain/tenant-id.js';
import { decodeOrderReady } from './order-ready.decoder.js';

/**
 * Ánh xạ một message `OrderReadyForPaymentV1` sang `PayOrder`. Kết quả nghiệp vụ (kể cả từ chối) luôn `ack` vì kết quả
 * đã nằm trong outbox cùng transaction; message hỏng hoặc tenant lạ không bao giờ thành công khi thử lại nên `reject`
 * (vào DLQ); lỗi hạ tầng được để lan ra để consumer chuyển thành `retry`.
 */
export function createOrderReadyHandler(deps: {
  registry: TenantRegistry;
  payOrder: Pick<PayOrder, 'execute'>;
  log: Logger;
}): MessageHandler {
  return async (message: IncomingMessage): Promise<HandlerResult> => {
    const decoded = decodeOrderReady(message.body);
    if (!decoded.ok) {
      deps.log.error(
        { messageId: message.messageId, reason: decoded.reason },
        'rejecting unreadable order-ready message',
      );
      return { action: 'reject', reason: decoded.reason };
    }
    const { event } = decoded;

    let tenant: TenantId;
    try {
      tenant = deps.registry.resolve(event.tenantId);
    } catch (error) {
      if (error instanceof MissingTenantError || error instanceof UnknownTenantError) {
        deps.log.error(
          { messageId: message.messageId, eventId: event.eventId, orderId: event.orderId },
          'rejecting order-ready message for a tenant this service does not host',
        );
        return { action: 'reject', reason: 'unknown tenant' };
      }
      throw error;
    }

    const outcome = await deps.payOrder.execute({
      tenant,
      eventId: event.eventId,
      correlationId: event.correlationId,
      orderId: event.orderId,
      customerId: event.customerId,
      amount: event.amount,
      currency: event.currency,
    });
    deps.log.info(
      {
        tenantId: tenant.value,
        orderId: event.orderId,
        eventId: event.eventId,
        outcome: outcome.kind,
        ...(outcome.kind === 'REJECTED' ? { reason: outcome.reason } : {}),
      },
      'order payment handled',
    );
    return { action: 'ack' };
  };
}
