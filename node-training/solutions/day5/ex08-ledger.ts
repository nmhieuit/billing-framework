export interface Entry {
  account: string;
  amount: number;
}

export class Ledger {
  #references = new Set<string>();
  #balances = new Map<string, number>();

  post(reference: string, entries: Entry[]): void {
    if (entries.length < 2) {
      throw new Error('at least two entries required');
    }
    if (entries.reduce((total, e) => total + e.amount, 0) !== 0) {
      throw new Error('entries must balance');
    }
    if (this.#references.has(reference)) {
      throw new Error(`duplicate reference: ${reference}`);
    }
    this.#references.add(reference);
    for (const { account, amount } of entries) {
      this.#balances.set(account, this.balanceOf(account) + amount);
    }
  }

  balanceOf(account: string): number {
    return this.#balances.get(account) ?? 0;
  }
}
