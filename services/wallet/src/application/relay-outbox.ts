import type { TenantId } from '../domain/tenant-id.js';
import type { Clock, EventPublisher, Logger, PublishOutcome, TenantUnitOfWork } from './ports.js';

export const DEFAULT_OUTBOX_BACKOFF_SECONDS: readonly number[] = [1, 5, 30, 120, 600];

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_BATCH = 50;
const FALLBACK_DELAY_SECONDS = 60;

export type RelayOutcome = 'SENT' | 'UNROUTABLE' | 'FAILED';

export interface RelayReport {
  sent: number;
  unroutable: number;
  failed: number;
}

const plusSeconds = (date: Date, seconds: number): Date =>
  new Date(date.getTime() + seconds * 1000);

/**
 * Đẩy outbox ra broker: chiếm MỘT dòng bằng lease trong transaction ngắn, publish NGOÀI transaction, rồi ghi kết quả
 * trong transaction mới. Giao ít nhất một lần (chết giữa publish và `markSent` thì gửi lại sau lease); bên nhận khử
 * trùng theo `eventId`. Không bao giờ bỏ dòng: thất bại chỉ hẹn lại theo backoff.
 */
export class RelayOutbox {
  private readonly leaseSeconds: number;

  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      publisher: EventPublisher;
      clock: Clock;
      log: Logger;
      backoffSeconds: readonly number[];
      leaseSeconds?: number;
    },
  ) {
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  async executeNextDue(tenant: TenantId): Promise<RelayOutcome | null> {
    const claimed = await this.deps.uow.run(tenant, async ({ outbox }) => {
      const now = this.deps.clock.now();
      const message = await outbox.lockNextDue(now);
      if (!message) return null;
      await outbox.lease(message.id, plusSeconds(now, this.leaseSeconds));
      return message;
    });
    if (!claimed) return null;

    let result: PublishOutcome;
    try {
      result = await this.deps.publisher.publish(claimed);
    } catch (error) {
      result = { kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }

    const now = this.deps.clock.now();
    const delay =
      this.deps.backoffSeconds[Math.min(claimed.attempts, this.deps.backoffSeconds.length - 1)] ??
      FALLBACK_DELAY_SECONDS;
    await this.deps.uow.run(tenant, async ({ outbox }) => {
      if (result.kind === 'delivered') await outbox.markSent(claimed.id, now);
      else await outbox.recordFailure(claimed.id, plusSeconds(now, delay));
    });

    const details = {
      tenantId: tenant.value,
      eventId: claimed.id,
      eventType: claimed.eventType,
      routingKey: claimed.routingKey,
      attempt: claimed.attempts + 1,
    };
    if (result.kind === 'unroutable') {
      this.deps.log.warn(details, 'no queue is bound to receive the event; will retry');
      return 'UNROUTABLE';
    }
    if (result.kind === 'failed') {
      this.deps.log.error(
        { ...details, err: result.error },
        'publishing the event failed; will retry',
      );
      return 'FAILED';
    }
    return 'SENT';
  }

  async execute(
    tenant: TenantId,
    limit = DEFAULT_BATCH,
    options: { shouldContinue?: () => boolean } = {},
  ): Promise<RelayReport> {
    const report: RelayReport = { sent: 0, unroutable: 0, failed: 0 };
    for (let i = 0; i < limit; i++) {
      if (options.shouldContinue && !options.shouldContinue()) break;
      const outcome = await this.executeNextDue(tenant);
      if (outcome === null) break;
      if (outcome === 'SENT') report.sent += 1;
      else if (outcome === 'UNROUTABLE') report.unroutable += 1;
      else report.failed += 1;
    }
    return report;
  }
}
