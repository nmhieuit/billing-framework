import type { Money } from '@billing/money';
import { InvalidChargeError, StateTransitionError } from './errors.js';
import type { Scenario } from './scenario.js';

export const MAX_REFERENCE_LENGTH = 200;

export type ChargeStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export interface ChargeProps {
  readonly id: string;
  readonly reference: string;
  readonly amount: Money;
  readonly status: ChargeStatus;
  readonly failureCode: string | null;
  readonly scenario: Scenario;
  readonly dueAt: Date;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export class Charge {
  private constructor(private readonly props: ChargeProps) {}

  static create(input: {
    id: string;
    reference: string;
    amount: Money;
    scenario: Scenario;
    now: Date;
  }): Charge {
    if (input.reference.trim().length === 0 || input.reference.length > MAX_REFERENCE_LENGTH) {
      throw new InvalidChargeError(`reference must be 1..${MAX_REFERENCE_LENGTH} characters`);
    }
    if (!input.amount.isPositive()) {
      throw new InvalidChargeError('amount must be at least 1 minor unit');
    }
    const delayMs = (input.scenario.delaySeconds ?? 0) * 1000;
    return new Charge({
      id: input.id,
      reference: input.reference,
      amount: input.amount,
      status: 'PENDING',
      failureCode: null,
      scenario: input.scenario,
      dueAt: new Date(input.now.getTime() + delayMs),
      createdAt: input.now,
      completedAt: null,
    });
  }

  static rehydrate(props: ChargeProps): Charge {
    return new Charge(props);
  }

  isDue(now: Date): boolean {
    return this.props.status === 'PENDING' && this.props.dueAt.getTime() <= now.getTime();
  }

  complete(now: Date): Charge {
    if (this.props.status !== 'PENDING') {
      throw new StateTransitionError(`charge ${this.props.id} is already ${this.props.status}`);
    }
    if (!this.isDue(now)) {
      throw new StateTransitionError(`charge ${this.props.id} is not due yet`);
    }
    const failureCode = this.props.scenario.fail;
    return new Charge({
      ...this.props,
      status: failureCode === null ? 'SUCCEEDED' : 'FAILED',
      failureCode,
      completedAt: now,
    });
  }

  toProps(): ChargeProps {
    return { ...this.props };
  }
}
