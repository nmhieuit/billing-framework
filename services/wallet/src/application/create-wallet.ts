import { Money, type Currency } from '@billing/money';
import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { DuplicateKeyError, WalletCurrencyConflictError } from './errors.js';
import type { Clock, TenantUnitOfWork } from './ports.js';
import { toWalletView, type WalletView } from './views.js';

export interface CreateWalletInput {
  tenant: TenantId;
  customerId: CustomerId;
  currency: string;
}

export interface CreateWalletResult {
  created: boolean;
  wallet: WalletView;
}

export class CreateWallet {
  constructor(private readonly deps: { uow: TenantUnitOfWork; clock: Clock }) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletResult> {
    // Money.zero ném InvalidMoneyError với đồng tiền không được hỗ trợ.
    const currency = Money.zero(input.currency as Currency).currency;

    const attempt = (): Promise<CreateWalletResult> =>
      this.deps.uow.run(input.tenant, async ({ accounts }) => {
        const existing = await accounts.find(Account.walletId(input.customerId));
        if (existing) {
          if (existing.toProps().currency !== currency) {
            throw new WalletCurrencyConflictError(
              `customer already has a wallet in ${existing.toProps().currency}`,
            );
          }
          return { created: false, wallet: toWalletView(existing) };
        }
        const wallet = Account.openWallet({
          customerId: input.customerId,
          currency,
          now: this.deps.clock.now(),
        });
        await accounts.insert(wallet);
        return { created: true, wallet: toWalletView(wallet) };
      });

    try {
      return await attempt();
    } catch (error) {
      // Hai lần tạo đồng thời: bên thua vấp khóa chính (giao dịch đã rollback); chạy lại một lần để thấy ví của bên thắng.
      if (error instanceof DuplicateKeyError) return await attempt();
      throw error;
    }
  }
}
