export function createWallet(owner) {
  return { owner: owner, balance: 0 };
}

export function deposit(wallet, amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new Error('amount must be a positive integer');
  }
  wallet.balance = wallet.balance + amount;
  return wallet.balance;
}
