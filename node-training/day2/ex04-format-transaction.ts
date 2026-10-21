// Bài 4 (Trung bình): destructuring + template string.
// formatTransaction({ id: 'a1', type: 'deposit', amount: 100 })  -> 'a1: +100'
// formatTransaction({ id: 'b2', type: 'withdraw', amount: 30 })  -> 'b2: -30'
// Gợi ý: const { id, type, amount } = tx;
import type { Transaction } from './transaction.js';

export function formatTransaction(tx: Transaction): string {
  // TODO
  return '';
}
