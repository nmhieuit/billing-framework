// Đã viết sẵn cho các bài Ngày 5. Không cần sửa.
export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export interface WalletRepository {
  save(wallet: Wallet): void;
  findById(id: string): Wallet | undefined;
}

export class InMemoryWalletRepository implements WalletRepository {
  readonly #wallets = new Map<string, Wallet>();

  save(wallet: Wallet): void {
    this.#wallets.set(wallet.id, { ...wallet });
  }

  findById(id: string): Wallet | undefined {
    const found = this.#wallets.get(id);
    return found ? { ...found } : undefined;
  }
}
