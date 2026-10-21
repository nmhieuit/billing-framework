export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export class WalletRepository {
  #wallets = new Map<string, Wallet>();

  save(wallet: Wallet): void {
    this.#wallets.set(wallet.id, { ...wallet });
  }

  findById(id: string): Wallet | undefined {
    const found = this.#wallets.get(id);
    return found ? { ...found } : undefined;
  }

  count(): number {
    return this.#wallets.size;
  }
}
