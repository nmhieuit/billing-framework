import { onlyDeposits } from './ex02-only-deposits.js';
import type { Transaction } from './transaction.js';

export interface Summary {
  count: number;
  totalDeposited: number;
  ids: string[];
}

export function summarize(transactions: Transaction[]): Summary {
  const deposits = onlyDeposits(transactions);
  return {
    count: deposits.length,
    totalDeposited: deposits.reduce((total, tx) => total + tx.amount, 0),
    ids: deposits.map((tx) => tx.id),
  };
}
