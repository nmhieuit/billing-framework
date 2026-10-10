import { Account } from '../domain/account.js';
import { StateTransitionError } from '../domain/errors.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { Topup } from '../domain/topup.js';
import { DuplicateKeyError } from './errors.js';
import type { Clock, IdGenerator, Logger, Repositories, TenantUnitOfWork } from './ports.js';

export type PaymentEventType = 'charge.succeeded' | 'charge.failed';

export interface ApplyPaymentResultInput {
  tenant: TenantId;
  eventId: string;
  type: PaymentEventType;
  chargeId: string;
  /** `topupId` mà wallet đã gửi làm `reference` khi tạo charge. */
  reference: string;
  amount: number;
  currency: string;
  failureCode?: string | undefined;
}

export type ApplyOutcome = 'APPLIED' | 'DUPLICATE' | 'UNKNOWN_TOPUP' | 'MISMATCH' | 'IGNORED';

const CONSUMER = 'payment-webhook';
const UNKNOWN_FAILURE_CODE = 'unknown';

export class ApplyPaymentResult {
  constructor(
    private readonly deps: { uow: TenantUnitOfWork; clock: Clock; ids: IdGenerator; log: Logger },
  ) {}

  async execute(input: ApplyPaymentResultInput): Promise<ApplyOutcome> {
    let outcome: ApplyOutcome;
    try {
      outcome = await this.deps.uow.run(input.tenant, (repositories) =>
        this.apply(repositories, input),
      );
    } catch (error) {
      // Cùng eventId (inbox) hoặc cùng business_key (sổ cái): giao dịch đã rollback, tiền đã được ghi trước đó.
      if (error instanceof DuplicateKeyError) return 'DUPLICATE';
      throw error;
    }
    this.report(outcome, input);
    return outcome;
  }

  private async apply(
    { accounts, ledger, topups, inbox }: Repositories,
    input: ApplyPaymentResultInput,
  ): Promise<ApplyOutcome> {
    const now = this.deps.clock.now();
    await inbox.record(CONSUMER, input.eventId, now);

    const topup = await topups.lockById(input.reference);
    if (!topup) return 'UNKNOWN_TOPUP';

    const props = topup.toProps();
    const consistent =
      props.amount.amount === input.amount &&
      props.amount.currency === input.currency &&
      (props.chargeId === null || props.chargeId === input.chargeId);
    if (!consistent) return 'MISMATCH';

    const next = this.transition(topup, input, now);
    if (next === null) return 'IGNORED';

    if (input.type === 'charge.succeeded') {
      const walletId = props.accountId;
      const gatewayId = Account.systemId('GATEWAY', props.amount.currency);
      const locked = await accounts.lockMany([walletId, gatewayId]);
      const byId = new Map(locked.map((account) => [account.toProps().id, account]));
      const wallet = byId.get(walletId);
      const gateway = byId.get(gatewayId);
      if (!wallet || !gateway) throw new Error(`missing account for topup ${props.id}`);

      await accounts.saveBalance(wallet.apply(props.amount));
      await accounts.saveBalance(gateway.apply(props.amount.negate()));
      await ledger.post(
        LedgerTransaction.topup({
          id: this.deps.ids.transactionId(),
          topupId: props.id,
          walletAccountId: walletId,
          gatewayAccountId: gatewayId,
          amount: props.amount,
          now,
        }),
      );
    }
    await topups.save(next);
    return 'APPLIED';
  }

  /** `null` khi trạng thái hiện tại không cho phép chuyển (đã chốt, hoặc thất bại vì lý do khác). */
  private transition(topup: Topup, input: ApplyPaymentResultInput, now: Date): Topup | null {
    try {
      return input.type === 'charge.succeeded'
        ? topup.applySucceeded(input.chargeId, now)
        : topup.applyFailed(input.failureCode ?? UNKNOWN_FAILURE_CODE, input.chargeId, now);
    } catch (error) {
      if (error instanceof StateTransitionError) return null;
      throw error;
    }
  }

  private report(outcome: ApplyOutcome, input: ApplyPaymentResultInput): void {
    const details = {
      tenantId: input.tenant.value,
      eventId: input.eventId,
      type: input.type,
      reference: input.reference,
      chargeId: input.chargeId,
    };
    switch (outcome) {
      case 'UNKNOWN_TOPUP':
        this.deps.log.error(details, 'payment event references an unknown topup');
        break;
      case 'MISMATCH':
        this.deps.log.error(details, 'payment event does not match the topup; ledger untouched');
        break;
      case 'IGNORED':
        if (input.type === 'charge.failed') {
          this.deps.log.error(details, 'charge.failed ignored: the topup is already settled');
        } else {
          this.deps.log.warn(
            details,
            'charge.succeeded ignored: the topup cannot be completed from its state',
          );
        }
        break;
      case 'APPLIED':
      case 'DUPLICATE':
        break;
    }
  }
}
