import type { Transaction } from './transaction.js';

export function formatTransaction(tx: Transaction): string {
  const { id, type, amount } = tx;
  const sign = type === 'deposit' ? '+' : '-';
  return `${id}: ${sign}${amount}`;
}
