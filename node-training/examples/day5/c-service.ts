import { WalletRepository } from './b-repository.js';

export class WalletNotFoundError extends Error {
  constructor(id: string) {
    super(`wallet not found: ${id}`);
  }
}

export class WalletService {
  constructor(private readonly repo: WalletRepository) {}

  deposit(id: string, amount: number): number {
    const wallet = this.repo.findById(id);
    if (!wallet) {
      throw new WalletNotFoundError(id);
    }
    wallet.balance += amount;
    this.repo.save(wallet);
    return wallet.balance;
  }
}
