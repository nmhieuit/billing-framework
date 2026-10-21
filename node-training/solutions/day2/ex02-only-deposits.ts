import type { Transaction } from './transaction.js';

export function onlyDeposits(transactions: Transaction[]): Transaction[] {
  return transactions.filter((tx) => tx.type === 'deposit');
}
