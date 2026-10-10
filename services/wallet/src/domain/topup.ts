import type { Money } from '@billing/money';
import type { CustomerId } from './customer-id.js';
import { InvalidTopupError, StateTransitionError } from './errors.js';

export type TopupStatus = 'REQUESTED' | 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface TopupProps {
  readonly id: string;
  readonly customerId: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly status: TopupStatus;
  readonly chargeId: string | null;
  readonly failureCode: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/** Trần một lần nạp (đơn vị nhỏ nhất): chặn số vô lý trước khi chạm DB hay payment. */
export const MAX_TOPUP_AMOUNT = 1_000_000_000_000;

const PAYMENT_REJECTED = 'PAYMENT_REJECTED';
const PAYMENT_UNAVAILABLE = 'PAYMENT_UNAVAILABLE';

const addSeconds = (date: Date, seconds: number): Date => new Date(date.getTime() + seconds * 1000);

export class Topup {
  private constructor(private readonly props: TopupProps) {}

  static request(input: {
    id: string;
    customerId: CustomerId;
    accountId: string;
    amount: Money;
    now: Date;
  }): Topup {
    if (!input.amount.isPositive()) {
      throw new InvalidTopupError('amount must be at least 1 minor unit');
    }
    if (input.amount.amount > MAX_TOPUP_AMOUNT) {
      throw new InvalidTopupError(`amount must not exceed ${MAX_TOPUP_AMOUNT} minor units`);
    }
    return new Topup({
      id: input.id,
      customerId: input.customerId.value,
      accountId: input.accountId,
      amount: input.amount,
      status: 'REQUESTED',
      chargeId: null,
      failureCode: null,
      attempts: 0,
      nextAttemptAt: input.now,
      createdAt: input.now,
      completedAt: null,
    });
  }

  static rehydrate(props: TopupProps): Topup {
    return new Topup(props);
  }

  isDue(now: Date): boolean {
    return (
      this.props.status === 'REQUESTED' &&
      this.props.nextAttemptAt !== null &&
      this.props.nextAttemptAt.getTime() <= now.getTime()
    );
  }

  /** Chiếm lần nạp để gửi sang payment: đẩy lịch lên sau `leaseSeconds`, chưa tính là một lần thử. */
  claim(now: Date, leaseSeconds: number): Topup {
    this.assertRequested('claim');
    return new Topup({ ...this.props, nextAttemptAt: addSeconds(now, leaseSeconds) });
  }

  recordSubmitted(chargeId: string): Topup {
    this.assertRequested('recordSubmitted');
    return new Topup({
      ...this.props,
      status: 'PENDING',
      chargeId,
      attempts: this.props.attempts + 1,
      nextAttemptAt: null,
    });
  }

  recordRejected(now: Date): Topup {
    this.assertRequested('recordRejected');
    return new Topup({
      ...this.props,
      status: 'FAILED',
      failureCode: PAYMENT_REJECTED,
      attempts: this.props.attempts + 1,
      nextAttemptAt: null,
      completedAt: now,
    });
  }

  /** Lần thất bại thứ n (n <= len) hẹn lại sau `backoff[n-1]` giây; thứ len+1 thì FAILED. */
  recordUnavailable(now: Date, backoffSeconds: readonly number[]): Topup {
    this.assertRequested('recordUnavailable');
    const attempts = this.props.attempts + 1;
    const delay = backoffSeconds[attempts - 1];
    if (delay === undefined) {
      return new Topup({
        ...this.props,
        status: 'FAILED',
        failureCode: PAYMENT_UNAVAILABLE,
        attempts,
        nextAttemptAt: null,
        completedAt: now,
      });
    }
    return new Topup({ ...this.props, attempts, nextAttemptAt: addSeconds(now, delay) });
  }

  /** Thành công từ webhook; cho phép cả khi lần nạp đã FAILED vì PAYMENT_UNAVAILABLE (cổng thanh toán là nguồn sự thật). */
  applySucceeded(chargeId: string, now: Date): Topup {
    const { status, failureCode } = this.props;
    const lateSuccess = status === 'FAILED' && failureCode === PAYMENT_UNAVAILABLE;
    if (status !== 'REQUESTED' && status !== 'PENDING' && !lateSuccess) {
      throw new StateTransitionError(`topup ${this.props.id} cannot succeed from ${status}`);
    }
    return new Topup({
      ...this.props,
      status: 'SUCCEEDED',
      chargeId,
      failureCode: null,
      nextAttemptAt: null,
      completedAt: now,
    });
  }

  applyFailed(failureCode: string, chargeId: string, now: Date): Topup {
    const { status } = this.props;
    if (status !== 'REQUESTED' && status !== 'PENDING') {
      throw new StateTransitionError(`topup ${this.props.id} cannot fail from ${status}`);
    }
    return new Topup({
      ...this.props,
      status: 'FAILED',
      chargeId,
      failureCode,
      nextAttemptAt: null,
      completedAt: now,
    });
  }

  toProps(): TopupProps {
    return { ...this.props };
  }

  private assertRequested(operation: string): void {
    if (this.props.status !== 'REQUESTED') {
      throw new StateTransitionError(
        `topup ${this.props.id} is ${this.props.status}, cannot ${operation}`,
      );
    }
  }
}
