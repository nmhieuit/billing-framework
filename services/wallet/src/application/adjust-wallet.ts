import { Money, type Currency } from '@billing/money';
import { Account } from '../domain/account.js';
import { CustomerId } from '../domain/customer-id.js';
import { LedgerTransaction } from '../domain/ledger-transaction.js';
import { InvalidOpsRequestError } from '../domain/ops.js';
import type { TenantId } from '../domain/tenant-id.js';
import { WalletNotFoundError } from './errors.js';
import type { OpsActionRecorder, OpsRequest } from './ops-recorder.js';
import type { IdGenerator } from './ports.js';

export interface AdjustWalletInput extends OpsRequest {
  tenant: TenantId;
  customerId: string;
  direction: string;
  amount: number;
  currency: string;
}

export interface AdjustWalletResult {
  transactionId: string;
  actionId: string;
}

/** Điều chỉnh số dư ví bằng bút toán kép đối ứng tài khoản `ADJUSTMENT`; chạy được cả trên ví đang đóng băng. */
export class AdjustWallet {
  constructor(private readonly deps: { recorder: OpsActionRecorder; ids: IdGenerator }) {}

  async execute(input: AdjustWalletInput): Promise<AdjustWalletResult> {
    const run = await this.deps.recorder.run<AdjustWalletResult>({
      tenant: input.tenant,
      action: 'ADJUST',
      request: input,
      target: `wallet:${input.customerId}`,
      params: { direction: input.direction, amount: input.amount, currency: input.currency },
      work: async ({ repositories, actionId, now }) => {
        const { direction } = input;
        if (direction !== 'CREDIT' && direction !== 'DEBIT') {
          throw new InvalidOpsRequestError('direction must be CREDIT or DEBIT');
        }
        if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
          throw new InvalidOpsRequestError('amount must be a positive integer');
        }
        const customerId = CustomerId.parse(input.customerId);
        const walletId = Account.walletId(customerId);
        const found = await repositories.accounts.find(walletId);
        if (!found) throw new WalletNotFoundError(`wallet for ${customerId.value} not found`);
        if (found.toProps().currency !== input.currency) {
          throw new InvalidOpsRequestError('currency does not match the wallet currency');
        }
        const money = Money.of(input.amount, input.currency as Currency);
        const adjustmentId = Account.systemId('ADJUSTMENT', money.currency);

        // Khóa theo id tăng dần (cùng quy ước với PayOrder) nên không deadlock với các luồng khác.
        const locked = await repositories.accounts.lockMany([walletId, adjustmentId]);
        const byId = new Map(locked.map((account) => [account.toProps().id, account]));
        const wallet = byId.get(walletId);
        const adjustment = byId.get(adjustmentId);
        if (!wallet || !adjustment) throw new Error(`missing account for adjustment ${actionId}`);

        const delta = direction === 'CREDIT' ? money : money.negate();
        await repositories.accounts.saveBalance(wallet.apply(delta));
        await repositories.accounts.saveBalance(adjustment.apply(delta.negate()));

        const transactionId = this.deps.ids.transactionId();
        await repositories.ledger.post(
          LedgerTransaction.adjustment({
            id: transactionId,
            actionId,
            walletAccountId: walletId,
            adjustmentAccountId: adjustmentId,
            direction,
            amount: money,
            now,
          }),
        );
        return { result: { transactionId, actionId }, record: true };
      },
    });
    return run.result;
  }
}
