import type { TenantId } from '../domain/tenant-id.js';
import { EventIdUnknownError, OrderNotFoundError, OrderReversedError } from './errors.js';
import { orderPaidMessage } from './order-events.js';
import type { OpsActionRecorder, OpsRequest } from './ops-recorder.js';
import type { IdGenerator } from './ports.js';

export interface ReplayOrderPaidInput extends OpsRequest {
  tenant: TenantId;
  orderId: string;
}

export interface ReplayOrderPaidResult {
  eventId: string;
  actionId: string;
}

/**
 * Phát lại `OrderPaidV1` của một đơn đã trả: dòng outbox mới (id mới) nhưng `payload.eventId` và thời điểm của sự kiện gốc,
 * để consumer dedupe theo `eventId`. Không đụng tới sổ cái.
 */
export class ReplayOrderPaid {
  constructor(private readonly deps: { recorder: OpsActionRecorder; ids: IdGenerator }) {}

  async execute(input: ReplayOrderPaidInput): Promise<ReplayOrderPaidResult> {
    const run = await this.deps.recorder.run<ReplayOrderPaidResult>({
      tenant: input.tenant,
      action: 'REPLAY_PAID',
      request: input,
      target: `order:${input.orderId}`,
      params: {},
      work: async ({ repositories, actionId, now }) => {
        const { orderPayments, ledger, outbox } = repositories;
        const paid = await orderPayments.find(input.orderId);
        if (!paid) throw new OrderNotFoundError('order not found');
        if ((await ledger.findReversalOf(paid.walletTransactionId)) !== null) {
          throw new OrderReversedError('order payment has been reversed');
        }
        if (paid.paidEventId === null) {
          throw new EventIdUnknownError('original OrderPaidV1 event id is unknown');
        }
        await outbox.add(
          orderPaidMessage(
            {
              tenantId: input.tenant.value,
              correlationId: `ops-replay:${actionId}`,
              eventId: paid.paidEventId,
              now,
            },
            {
              orderId: paid.orderId,
              walletTransactionId: paid.walletTransactionId,
              amount: paid.amount,
              paidAt: paid.paidAt,
            },
            { outboxId: this.deps.ids.eventId(), occurredAt: paid.paidAt },
          ),
        );
        return { result: { eventId: paid.paidEventId, actionId }, record: true };
      },
    });
    return run.result;
  }
}
