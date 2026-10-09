import type { Clock, UnitOfWork, WebhookSender } from './ports.js';

const DEFAULT_BATCH = 50;
const DEFAULT_LEASE_SECONDS = 60;

export interface DeliveryReport {
  delivered: number;
  retrying: number;
  failed: number;
}

export class DeliverDueWebhooks {
  private readonly leaseSeconds: number;

  constructor(
    private readonly deps: {
      uow: UnitOfWork;
      sender: WebhookSender;
      clock: Clock;
      backoffSeconds: readonly number[];
      leaseSeconds?: number;
    },
  ) {
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  /**
   * 1) Trong một transaction: chọn sự kiện đến hạn rồi "chiếm" chúng bằng cách đẩy `next_attempt_at`
   *    thêm một lease. 2) Gửi HTTP NGOÀI transaction (không giữ khóa DB trong lúc chờ mạng).
   * 3) Ghi kết quả. Nếu tiến trình chết giữa chừng, sự kiện tự đến hạn lại khi lease hết.
   */
  async execute(limit = DEFAULT_BATCH): Promise<DeliveryReport> {
    const claimed = await this.deps.uow.run(async ({ webhooks }) => {
      const now = this.deps.clock.now();
      const due = await webhooks.lockDue(now, limit);
      for (const event of due) await webhooks.save(event.claim(now, this.leaseSeconds));
      return due;
    });

    const report: DeliveryReport = { delivered: 0, retrying: 0, failed: 0 };
    for (const event of claimed) {
      const result = await this.deps.sender.send(event, this.deps.clock.now());

      const status = await this.deps.uow.run(async ({ webhooks }) => {
        const now = this.deps.clock.now();
        const updated = result.ok
          ? event.recordSuccess(now)
          : event.recordFailure(now, this.deps.backoffSeconds);
        const props = updated.toProps();
        await webhooks.save(updated);
        await webhooks.recordAttempt({
          eventId: props.eventId,
          attemptNo: props.attempts,
          attemptedAt: now,
          statusCode: result.statusCode ?? null,
          error: result.ok ? null : (result.error ?? null),
        });
        return props.status;
      });

      if (status === 'DELIVERED') report.delivered += 1;
      else if (status === 'PENDING') report.retrying += 1;
      else report.failed += 1;

      // webhook=duplicate: gửi thêm một bản giống hệt, không tính vào lần thử và không ảnh hưởng trạng thái.
      if (result.ok && event.toProps().sendTwice) {
        await this.deps.sender.send(event, this.deps.clock.now());
      }
    }
    return report;
  }
}
