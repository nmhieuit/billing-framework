import type { TenantId } from '../domain/tenant-id.js';
import type { Topup } from '../domain/topup.js';
import type {
  Clock,
  GatewayChargeResult,
  Logger,
  PaymentGateway,
  TenantUnitOfWork,
} from './ports.js';

export type SubmitOutcome =
  'SUBMITTED' | 'REJECTED' | 'RETRY_SCHEDULED' | 'FAILED' | 'SUPERSEDED' | 'NOT_DUE';

const DEFAULT_LEASE_SECONDS = 60;

/**
 * Gửi một lần nạp sang payment. Đường code duy nhất cho cả lần thử ngay sau `POST /topups` lẫn worker:
 * (a) chiếm lần nạp bằng lease trong transaction ngắn, (b) gọi payment NGOÀI transaction (idempotency key
 * cố định nên gọi lại luôn an toàn), (c) ghi kết quả trong transaction mới — trừ khi webhook đã chốt trước.
 */
export class SubmitTopup {
  private readonly leaseSeconds: number;

  constructor(
    private readonly deps: {
      uow: TenantUnitOfWork;
      gateway: PaymentGateway;
      clock: Clock;
      log: Logger;
      backoffSeconds: readonly number[];
      leaseSeconds?: number;
    },
  ) {
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  async executeFor(tenant: TenantId, topupId: string): Promise<SubmitOutcome> {
    const claimed = await this.deps.uow.run(tenant, async ({ topups }) => {
      const topup = await topups.lockById(topupId);
      if (!topup) return null;
      const now = this.deps.clock.now();
      if (!topup.isDue(now)) return null;
      await topups.save(topup.claim(now, this.leaseSeconds));
      return topup;
    });
    return claimed ? this.submitClaimed(tenant, claimed) : 'NOT_DUE';
  }

  /** Lần nạp đến hạn cũ nhất của tenant; `null` khi không còn gì đến hạn. */
  async executeNextDue(tenant: TenantId): Promise<SubmitOutcome | null> {
    const claimed = await this.deps.uow.run(tenant, async ({ topups }) => {
      const now = this.deps.clock.now();
      const topup = await topups.lockNextDue(now);
      if (!topup) return null;
      await topups.save(topup.claim(now, this.leaseSeconds));
      return topup;
    });
    return claimed ? this.submitClaimed(tenant, claimed) : null;
  }

  private async submitClaimed(tenant: TenantId, claimed: Topup): Promise<SubmitOutcome> {
    const props = claimed.toProps();
    const result = await this.deps.gateway.createCharge({
      idempotencyKey: `topup:${tenant.value}:${props.id}`,
      amount: props.amount,
      reference: props.id,
      metadata: { tenantId: tenant.value },
    });

    let attempts = 0;
    const outcome = await this.deps.uow.run(tenant, async ({ topups }): Promise<SubmitOutcome> => {
      const current = await topups.lockById(props.id);
      // Webhook có thể đã chốt lần nạp trong lúc ta chờ payment: không ghi đè.
      if (!current || current.toProps().status !== 'REQUESTED') return 'SUPERSEDED';
      const now = this.deps.clock.now();
      switch (result.kind) {
        case 'created':
          await topups.save(current.recordSubmitted(result.chargeId));
          return 'SUBMITTED';
        case 'rejected': {
          const rejected = current.recordRejected(now);
          attempts = rejected.toProps().attempts;
          await topups.save(rejected);
          return 'REJECTED';
        }
        case 'unavailable': {
          const next = current.recordUnavailable(now, this.deps.backoffSeconds);
          attempts = next.toProps().attempts;
          await topups.save(next);
          return next.toProps().status === 'FAILED' ? 'FAILED' : 'RETRY_SCHEDULED';
        }
        default: {
          const exhaustive: never = result;
          throw new Error(`Unhandled gateway result: ${JSON.stringify(exhaustive)}`);
        }
      }
    });
    // Ghi log SAU khi transaction kết quả đã commit; không bao giờ ghi bí mật hay thân yêu cầu.
    this.report(outcome, tenant, props.id, result, attempts);
    return outcome;
  }

  private report(
    outcome: SubmitOutcome,
    tenant: TenantId,
    topupId: string,
    result: GatewayChargeResult,
    attempts: number,
  ): void {
    const details = { tenantId: tenant.value, topupId };
    if (outcome === 'REJECTED' && result.kind === 'rejected') {
      this.deps.log.error(
        { ...details, gatewayStatus: result.status, gatewayMessage: result.message },
        'topup rejected by payment; marked FAILED (PAYMENT_REJECTED)',
      );
    } else if (outcome === 'FAILED' && result.kind === 'unavailable') {
      this.deps.log.error(
        { ...details, attempts, lastError: result.error },
        'topup failed: payment unavailable and retries exhausted (PAYMENT_UNAVAILABLE)',
      );
    } else if (outcome === 'RETRY_SCHEDULED' && result.kind === 'unavailable') {
      this.deps.log.warn(
        { ...details, attempt: attempts, error: result.error },
        'payment unavailable; topup retry scheduled',
      );
    }
  }
}
