import { LedgerInvariantError } from '../domain/errors.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import type { TenantId } from '../domain/tenant-id.js';
import {
  AlreadyReversedError,
  DuplicateKeyError,
  ReversalNotPossibleError,
  ReversalNotSupportedError,
  TransactionNotFoundError,
} from './errors.js';
import type { OpsActionRecorder, OpsRequest } from './ops-recorder.js';
import type { IdGenerator } from './ports.js';

export interface ReverseTransactionInput extends OpsRequest {
  tenant: TenantId;
  transactionId: string;
}

export interface ReverseTransactionResult {
  transactionId: string;
  reversesTransactionId: string;
  actionId: string;
}

/**
 * Đảo một giao dịch `ORDER_PAYMENT` hoặc `ADJUSTMENT` bằng giao dịch `REVERSAL` mới (không sửa giao dịch gốc).
 * Số dư được áp lại qua `Account.apply` nên quy tắc dấu của ví/MERCHANT vẫn đúng; chạy được cả trên ví đang đóng băng.
 */
export class ReverseTransaction {
  constructor(private readonly deps: { recorder: OpsActionRecorder; ids: IdGenerator }) {}

  async execute(input: ReverseTransactionInput): Promise<ReverseTransactionResult> {
    const run = await this.deps.recorder.run<ReverseTransactionResult>({
      tenant: input.tenant,
      action: 'REVERSE',
      request: input,
      target: `transaction:${input.transactionId}`,
      params: {},
      work: async ({ repositories, actionId, now }) => {
        const { ledger, accounts } = repositories;
        const original = await ledger.findTransaction(input.transactionId);
        if (!original) throw new TransactionNotFoundError('transaction not found');
        if (original.kind !== 'ORDER_PAYMENT' && original.kind !== 'ADJUSTMENT') {
          throw new ReversalNotSupportedError(
            `transactions of kind ${original.kind} cannot be reversed`,
          );
        }

        const reversal = LedgerTransaction.reversal({
          id: this.deps.ids.transactionId(),
          original,
          now,
        });
        const reversalProps = reversal.toProps();

        // Khóa theo id tăng dần (cùng quy ước với PayOrder/AdjustWallet) nên không deadlock với các luồng khác.
        const locked = await accounts.lockMany(reversalProps.entries.map((e) => e.accountId));
        const byId = new Map(locked.map((account) => [account.toProps().id, account]));

        // Kiểm tra SAU khi giữ khóa: hai lần đảo song song cùng giao dịch bị tuần tự hóa bởi khóa tài khoản,
        // bên đến sau thấy giao dịch đảo của bên trước đã commit.
        if ((await ledger.findReversalOf(original.id)) !== null) {
          throw new AlreadyReversedError('transaction is already reversed');
        }

        for (const entry of reversalProps.entries) {
          const account = byId.get(entry.accountId);
          if (!account) {
            throw new Error(`missing account ${entry.accountId} for reversal ${actionId}`);
          }
          try {
            await accounts.saveBalance(account.apply(entry.amount));
          } catch (error) {
            // MERCHANT sẽ âm: không thể đảo. Ví thiếu tiền (InsufficientFundsError) giữ nguyên.
            if (error instanceof LedgerInvariantError) {
              throw new ReversalNotPossibleError(
                `reversal would break the balance of ${entry.accountId}`,
              );
            }
            throw error;
          }
        }

        try {
          await ledger.post(reversal);
        } catch (error) {
          // Chốt cuối: chỉ mục duy nhất reverses_transaction_id nếu có đường đua lọt qua khóa.
          if (error instanceof DuplicateKeyError && error.source === 'ledger') {
            throw new AlreadyReversedError('transaction is already reversed');
          }
          throw error;
        }
        return {
          result: {
            transactionId: reversalProps.id,
            reversesTransactionId: original.id,
            actionId,
          },
          record: true,
        };
      },
    });
    return run.result;
  }
}
