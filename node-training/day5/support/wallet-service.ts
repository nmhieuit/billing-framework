// Đã viết sẵn cho các bài Ngày 5. Không cần sửa.
import { InvalidAmountError, WalletNotFoundError } from './errors.js';
import type { Wallet, WalletRepository } from './wallet-repository.js';

export class WalletService {
  constructor(private readonly repo: WalletRepository) {}

  open(owner: string): Wallet {
    const wallet: Wallet = { id: `w-${owner.toLowerCase()}`, owner, balance: 0 };
    this.repo.save(wallet);
    return wallet;
  }

  deposit(id: string, amount: number): Wallet {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new InvalidAmountError();
    }
    const wallet = this.repo.findById(id);
    if (!wallet) {
      throw new WalletNotFoundError(id);
    }
    wallet.balance += amount;
    this.repo.save(wallet);
    return wallet;
  }

  get(id: string): Wallet {
    const wallet = this.repo.findById(id);
    if (!wallet) {
      throw new WalletNotFoundError(id);
    }
    return wallet;
  }
}
