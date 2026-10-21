import { InvalidAmountError, WalletNotFoundError } from './support/errors.js';
import type { Wallet, WalletRepository } from './support/wallet-repository.js';

export class InsufficientFundsError extends Error {
  constructor() {
    super('insufficient funds');
    this.name = 'InsufficientFundsError';
  }
}

export class WithdrawService {
  constructor(private readonly repo: WalletRepository) {}

  withdraw(id: string, amount: number): Wallet {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new InvalidAmountError();
    }
    const wallet = this.repo.findById(id);
    if (!wallet) {
      throw new WalletNotFoundError(id);
    }
    if (amount > wallet.balance) {
      throw new InsufficientFundsError();
    }
    wallet.balance -= amount;
    this.repo.save(wallet);
    return wallet;
  }
}
