export class Wallet {
  #balance = 0;

  constructor(readonly owner: string) {}

  get balance(): number {
    return this.#balance;
  }

  deposit(amount: number): number {
    this.#assertAmount(amount);
    this.#balance += amount;
    return this.#balance;
  }

  withdraw(amount: number): number {
    this.#assertAmount(amount);
    if (amount > this.#balance) {
      throw new Error('insufficient funds');
    }
    this.#balance -= amount;
    return this.#balance;
  }

  #assertAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error('amount must be a positive integer');
    }
  }
}
