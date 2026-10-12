import { Account } from '../domain/account.js';
import { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { WalletNotFoundError } from './errors.js';
import type { OpsActionRecorder, OpsRequest } from './ops-recorder.js';

export interface FreezeWalletInput extends OpsRequest {
  tenant: TenantId;
  customerId: string;
  frozen: boolean;
}

export interface FreezeWalletResult {
  customerId: string;
  frozen: boolean;
  changed: boolean;
  frozenAt: string | null;
  actionId: string | null;
}

/** Đóng băng / mở băng ví. Đã đúng trạng thái thì không đổi gì và không ghi kiểm toán. */
export class FreezeWallet {
  constructor(private readonly deps: { recorder: OpsActionRecorder }) {}

  async execute(input: FreezeWalletInput): Promise<FreezeWalletResult> {
    const run = await this.deps.recorder.run<FreezeWalletResult>({
      tenant: input.tenant,
      action: input.frozen ? 'FREEZE' : 'UNFREEZE',
      request: input,
      target: `wallet:${input.customerId}`,
      params: { frozen: input.frozen },
      work: async ({ repositories, actionId, now, request }) => {
        const customerId = CustomerId.parse(input.customerId);
        const walletId = Account.walletId(customerId);
        const found = await repositories.accounts.find(walletId);
        if (!found) throw new WalletNotFoundError(`wallet for ${customerId.value} not found`);
        const [locked] = await repositories.accounts.lockMany([walletId]);
        if (!locked) throw new WalletNotFoundError(`wallet for ${customerId.value} not found`);
        // Kiểm tra lại trên bản đã khóa: hai yêu cầu đồng thời khác khóa không được cùng ghi "đã đổi".
        if (locked.isFrozen() === input.frozen) {
          return {
            result: {
              customerId: customerId.value,
              frozen: input.frozen,
              changed: false,
              frozenAt: locked.toProps().frozen?.at.toISOString() ?? null,
              actionId: null,
            },
            record: false,
          };
        }
        const next = input.frozen
          ? locked.freeze(request.actor, request.reason, now)
          : locked.unfreeze();
        await repositories.accounts.saveFrozen(next);
        return {
          result: {
            customerId: customerId.value,
            frozen: input.frozen,
            changed: true,
            frozenAt: next.toProps().frozen?.at.toISOString() ?? null,
            actionId,
          },
          record: true,
        };
      },
    });
    return run.result;
  }
}
