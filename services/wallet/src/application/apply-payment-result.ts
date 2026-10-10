import { Account } from '../domain/account.js';
import { StateTransitionError } from '../domain/errors.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import type { Topup, TopupProps } from '../domain/topup.js';
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
const PAYMENT_UNAVAILABLE = 'PAYMENT_UNAVAILABLE';

interface ApplyResult {
  outcome: ApplyOutcome;
  /** Lần nạp như đã đọc (trước khi chuyển trạng thái), để `report` ghi log đúng mức; `null` khi không tìm thấy. */
  topup: TopupProps | null;
}

export class ApplyPaymentResult {
  constructor(
    private readonly deps: { uow: TenantUnitOfWork; clock: Clock; ids: IdGenerator; log: Logger },
  ) {}

  async execute(input: ApplyPaymentResultInput): Promise<ApplyOutcome> {
    let result: ApplyResult;
    try {
      result = await this.deps.uow.run(input.tenant, (repositories) =>
        this.apply(repositories, input),
      );
    } catch (error) {
      if (error instanceof DuplicateKeyError) {
        // Inbox: webhook trùng, bình thường. Sổ cái: đã có `topup:<id>` mà lần nạp chưa SUCCEEDED thì dữ liệu bất nhất.
        if (error.source === 'ledger') {
          this.deps.log.error(
            { tenantId: input.tenant.value, eventId: input.eventId, reference: input.reference },
            `ledger already holds topup:${input.reference} but the topup is not SUCCEEDED; inconsistent`,
          );
        }
        return 'DUPLICATE';
      }
      throw error;
    }
    this.report(result, input);
    return result.outcome;
  }

  private async apply(
    { accounts, ledger, topups, inbox }: Repositories,
    input: ApplyPaymentResultInput,
  ): Promise<ApplyResult> {
    const now = this.deps.clock.now();
    await inbox.record(CONSUMER, input.eventId, now);

    const topup = await topups.lockById(input.reference);
    if (!topup) return { outcome: 'UNKNOWN_TOPUP', topup: null };

    const props = topup.toProps();
    const consistent =
      props.amount.amount === input.amount &&
      props.amount.currency === input.currency &&
      (props.chargeId === null || props.chargeId === input.chargeId);
    if (!consistent) return { outcome: 'MISMATCH', topup: props };

    const next = this.transition(topup, input, now);
    if (next === null) return { outcome: 'IGNORED', topup: props };

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
    return { outcome: 'APPLIED', topup: props };
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

  private report({ outcome, topup }: ApplyResult, input: ApplyPaymentResultInput): void {
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
        this.deps.log.error(
          {
            ...details,
            amount: input.amount,
            currency: input.currency,
            expected: topup && {
              amount: topup.amount.amount,
              currency: topup.amount.currency,
              chargeId: topup.chargeId,
            },
          },
          'payment event does not match the topup; ledger untouched',
        );
        break;
      case 'IGNORED': {
        const withState = {
          ...details,
          topupStatus: topup?.status,
          failureCode: topup?.failureCode,
        };
        if (input.type === 'charge.failed') {
          // Chỉ nghiêm trọng khi cổng báo thất bại mà ví đã được cộng tiền.
          if (topup?.status === 'SUCCEEDED') {
            this.deps.log.error(
              withState,
              'charge.failed ignored: the topup already SUCCEEDED (payment disagrees with the ledger)',
            );
          } else {
            this.deps.log.warn(withState, 'charge.failed ignored: the topup is already failed');
          }
        } else if (topup?.status === 'FAILED' && topup.failureCode !== PAYMENT_UNAVAILABLE) {
          this.deps.log.error(
            withState,
            'charge.succeeded ignored: the customer was charged but the wallet was not credited',
          );
        } else {
          this.deps.log.warn(withState, 'charge.succeeded ignored: the topup is already settled');
        }
        break;
      }
      case 'APPLIED':
      case 'DUPLICATE':
        break;
    }
  }
}
