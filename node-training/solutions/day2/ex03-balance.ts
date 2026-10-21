import type { Transaction } from './transaction.js';

export function balanceOf(transactions: Transaction[]): number {
  return transactions.reduce((balance, tx) => {
    return tx.type === 'deposit' ? balance + tx.amount : balance - tx.amount;
  }, 0);
}
