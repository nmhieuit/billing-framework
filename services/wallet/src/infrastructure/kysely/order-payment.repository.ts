import { isUniqueViolation } from '@billing/database';
import type { Kysely } from 'kysely';
import { DuplicateKeyError } from '../../application/errors.js';
import type { OrderPaymentRepository, PaidOrder } from '../../application/ports.js';
import { rowToPaidOrder, sqlDate } from './mappers.js';
import type { WalletDatabase } from './schema.js';

export class KyselyOrderPaymentRepository implements OrderPaymentRepository {
  constructor(private readonly db: Kysely<WalletDatabase>) {}

  async find(orderId: string): Promise<PaidOrder | null> {
    const row = await this.db
      .selectFrom('order_payments')
      .selectAll()
      .where('order_id', '=', orderId)
      .executeTakeFirst();
    return row ? rowToPaidOrder(row) : null;
  }

  async insert(order: PaidOrder): Promise<void> {
    try {
      await this.db
        .insertInto('order_payments')
        .values({
          order_id: order.orderId,
          customer_id: order.customerId,
          wallet_transaction_id: order.walletTransactionId,
          amount: order.amount.amount,
          currency: order.amount.currency,
          paid_at: sqlDate(order.paidAt),
        })
        .execute();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateKeyError(`order already paid: ${order.orderId}`, 'order_payment');
      }
      throw error;
    }
  }
}
