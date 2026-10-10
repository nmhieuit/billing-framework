import type { Charge } from './charge.js';
import { StateTransitionError } from './errors.js';
import { hasMetadata } from './metadata.js';

export type WebhookEventType = 'charge.succeeded' | 'charge.failed';
export type WebhookEventStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

export interface WebhookEventProps {
  readonly eventId: string;
  readonly chargeId: string;
  readonly type: WebhookEventType;
  readonly payload: string;
  readonly status: WebhookEventStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly sendTwice: boolean;
  readonly createdAt: Date;
  readonly deliveredAt: Date | null;
}

const addSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

export class WebhookEvent {
  private constructor(private readonly props: WebhookEventProps) {}

  static forCharge(charge: Charge, eventId: string, now: Date): WebhookEvent {
    const c = charge.toProps();
    if (c.status === 'PENDING' || c.completedAt === null) {
      throw new StateTransitionError(`charge ${c.id} is not completed`);
    }
    const type: WebhookEventType = c.status === 'SUCCEEDED' ? 'charge.succeeded' : 'charge.failed';
    const payload = JSON.stringify({
      eventId,
      type,
      createdAt: now.toISOString(),
      data: {
        chargeId: c.id,
        reference: c.reference,
        amount: c.amount.amount,
        currency: c.amount.currency,
        status: c.status,
        completedAt: c.completedAt.toISOString(),
        ...(c.failureCode === null ? {} : { failureCode: c.failureCode }),
        ...(hasMetadata(c.metadata) ? { metadata: c.metadata } : {}),
      },
    });
    return new WebhookEvent({
      eventId,
      chargeId: c.id,
      type,
      payload,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      sendTwice: c.scenario.webhook === 'duplicate',
      createdAt: now,
      deliveredAt: null,
    });
  }

  static rehydrate(props: WebhookEventProps): WebhookEvent {
    return new WebhookEvent(props);
  }

  isDue(now: Date): boolean {
    return (
      this.props.status === 'PENDING' &&
      this.props.nextAttemptAt !== null &&
      this.props.nextAttemptAt.getTime() <= now.getTime()
    );
  }

  /** Chiếm sự kiện để gửi: đẩy lịch lên sau `leaseSeconds`, chưa tính là một lần thử. */
  claim(now: Date, leaseSeconds: number): WebhookEvent {
    this.assertPending();
    return new WebhookEvent({ ...this.props, nextAttemptAt: addSeconds(now, leaseSeconds) });
  }

  recordSuccess(now: Date): WebhookEvent {
    this.assertPending();
    return new WebhookEvent({
      ...this.props,
      status: 'DELIVERED',
      attempts: this.props.attempts + 1,
      nextAttemptAt: null,
      deliveredAt: now,
    });
  }

  /**
   * Lần gửi đầu + tối đa `backoffSeconds.length` lần retry. Thất bại thứ n (n <= độ dài) hẹn lại sau
   * `backoffSeconds[n-1]` giây; vượt quá thì `FAILED` và giữ lại để điều tra.
   */
  recordFailure(now: Date, backoffSeconds: readonly number[]): WebhookEvent {
    this.assertPending();
    const attempts = this.props.attempts + 1;
    const delay = backoffSeconds[attempts - 1];
    if (delay === undefined) {
      return new WebhookEvent({ ...this.props, status: 'FAILED', attempts, nextAttemptAt: null });
    }
    return new WebhookEvent({ ...this.props, attempts, nextAttemptAt: addSeconds(now, delay) });
  }

  toProps(): WebhookEventProps {
    return { ...this.props };
  }

  private assertPending(): void {
    if (this.props.status !== 'PENDING') {
      throw new StateTransitionError(`webhook event ${this.props.eventId} is ${this.props.status}`);
    }
  }
}
