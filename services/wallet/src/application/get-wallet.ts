import { Account } from '../domain/account.js';
import type { CustomerId } from '../domain/customer-id.js';
import type { TenantId } from '../domain/tenant-id.js';
import { WalletNotFoundError } from './errors.js';
import type { TenantUnitOfWork } from './ports.js';
import { toWalletView, type WalletView } from './views.js';

export class GetWallet {
  constructor(private readonly deps: { uow: TenantUnitOfWork }) {}

  async execute(input: { tenant: TenantId; customerId: CustomerId }): Promise<WalletView> {
    const wallet = await this.deps.uow.run(input.tenant, ({ accounts }) =>
      accounts.find(Account.walletId(input.customerId)),
    );
    if (!wallet) throw new WalletNotFoundError('wallet not found');
    return toWalletView(wallet);
  }
}
