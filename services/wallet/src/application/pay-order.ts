import { Money, type Currency } from '@billing/money';
import { Account } from '../domain/account.js';
import { CustomerId } from '../domain/customer-id.js';
import { InsufficientFundsError, InvalidCustomerError } from '../domain/errors.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import { DuplicateKeyError } from './errors.js';
import {
  orderPaidMessage,
  orderPaymentFailedMessage,
  type EventContext,
  type PaymentFailureReason,
} from './order-events.js';
import type { Clock, IdGenerator, Logger, Repositories, TenantUnitOfWork } from './ports.js';

export interface PayOrderInput {
  tenant: TenantId;
  /** `eventId` của OrderReadyForPaymentV1: khóa của inbox. */
  eventId: string;
  correlationId: string;
  orderId: string;
  customerId: string;
  amount: number;
  currency: string;
}

export type PayOrderOutcome =
  | { kind: 'PAID'; walletTransactionId: string }
  | { kind: 'REPLAYED'; walletTransactionId: string }
  | { kind: 'REJECTED'; reason: PaymentFailureReason }
  | { kind: 'DUPLICATE' };

const CONSUMER = 'orders-events';

function parseCustomer(raw: string): CustomerId | null {
  try {
    return CustomerId.parse(raw);
  } catch (error) {
    if (error instanceof InvalidCustomerError) return null;
    throw error;
  }
}

/**
 * Trả một order từ ví trong MỘT transaction: inbox → (đã trả?) → ví/đồng tiền → khóa ví + MERCHANT → sổ kép →
 * `order_payments` → outbox. Nhánh từ chối vẫn commit (inbox + outbox). Chỉ lần trả thành công được ghi nhớ theo orderId.
 */
export class PayOrder {
  constructor(
    private readonly deps: { uow: TenantUnitOfWork; clock: Clock; ids: IdGenerator; log: Logger },
  ) {}

  async execute(input: PayOrderInput): Promise<PayOrderOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.uow.run(input.tenant, (repositories) =>
          this.pay(repositories, input),
        );
      } catch (error) {
        if (!(error instanceof DuplicateKeyError)) throw error;
        if (error.source === 'inbox') return { kind: 'DUPLICATE' };
        // Hai yêu cầu cùng orderId (eventId khác nhau) đua nhau: bên thua vấp khóa duy nhất của sổ cái hoặc
        // `order_payments` và giao dịch đã rollback; chạy lại một lần sẽ thấy khoản trả của bên thắng và phát lại.
        if (attempt >= 1) throw error;
      }
    }
  }

  private async pay(repositories: Repositories, input: PayOrderInput): Promise<PayOrderOutcome> {
    const { accounts, ledger, inbox, orderPayments, outbox } = repositories;
    const now = this.deps.clock.now();
    const context = (): EventContext => ({
      tenantId: input.tenant.value,
      correlationId: input.correlationId,
      eventId: this.deps.ids.eventId(),
      now,
    });
    const reject = async (reason: PaymentFailureReason): Promise<PayOrderOutcome> => {
      await outbox.add(orderPaymentFailedMessage(context(), { orderId: input.orderId, reason }));
      return { kind: 'REJECTED', reason };
    };

    await inbox.record(CONSUMER, input.eventId, now);

    const money = Money.of(input.amount, input.currency as Currency);

    const paid = await orderPayments.find(input.orderId);
    if (paid) {
      const same =
        paid.customerId === input.customerId &&
        paid.amount.amount === money.amount &&
        paid.amount.currency === money.currency;
      if (!same) {
        this.deps.log.warn(
          { tenantId: input.tenant.value, orderId: input.orderId, eventId: input.eventId },
          'order already paid with different details; refusing',
        );
        return reject('CONFLICT');
      }
      await outbox.add(
        orderPaidMessage(context(), {
          orderId: input.orderId,
          walletTransactionId: paid.walletTransactionId,
          amount: paid.amount,
          paidAt: paid.paidAt,
        }),
      );
      return { kind: 'REPLAYED', walletTransactionId: paid.walletTransactionId };
    }

    const customerId = parseCustomer(input.customerId);
    if (!customerId) return reject('WALLET_NOT_FOUND');
    const walletId = Account.walletId(customerId);
    const wallet = await accounts.find(walletId);
    if (!wallet) return reject('WALLET_NOT_FOUND');
    if (wallet.toProps().currency !== money.currency) return reject('CURRENCY_MISMATCH');

    // Khóa theo thứ tự id tăng dần (cùng quy ước với ApplyPaymentResult) nên không deadlock với việc nạp tiền.
    const merchantId = Account.systemId('MERCHANT', money.currency);
    const locked = await accounts.lockMany([walletId, merchantId]);
    const byId = new Map(locked.map((account) => [account.toProps().id, account]));
    const lockedWallet = byId.get(walletId);
    const merchant = byId.get(merchantId);
    if (!lockedWallet || !merchant) throw new Error(`missing account for order ${input.orderId}`);

    let debited: Account;
    try {
      debited = lockedWallet.apply(money.negate());
    } catch (error) {
      if (error instanceof InsufficientFundsError) return reject('INSUFFICIENT_FUNDS');
      throw error;
    }
    await accounts.saveBalance(debited);
    await accounts.saveBalance(merchant.apply(money));

    const transactionId = this.deps.ids.transactionId();
    await ledger.post(
      LedgerTransaction.orderPayment({
        id: transactionId,
        orderId: input.orderId,
        walletAccountId: walletId,
        merchantAccountId: merchantId,
        amount: money,
        now,
      }),
    );
    await orderPayments.insert({
      orderId: input.orderId,
      customerId: customerId.value,
      walletTransactionId: transactionId,
      amount: money,
      paidAt: now,
    });
    await outbox.add(
      orderPaidMessage(context(), {
        orderId: input.orderId,
        walletTransactionId: transactionId,
        amount: money,
        paidAt: now,
      }),
    );
    return { kind: 'PAID', walletTransactionId: transactionId };
  }
}
